# From issue to regression test

How a repro script moves from a GitHub issue to a proven fix and then into a
permanent regression test. This file covers the process around the harness,
not the harness itself. For how to run one, see `repro.js --help`. For how to
write one, see `docs/WRITING-REPROS.md`.

Each section says whether it describes something that **exists** in this repo
today or something **proposed**.

## The flow

```
issue filed ─► repro written ─► REPRODUCED on master ─► fix PR ─► fix proven ─► kept as a regression test
               (triager)         (the bug is real)               (--broken/--fixed)  (nightly + every PR)
```

### 1. A repro asserts the correct behaviour (exists)

`expect` states what *should* happen, and a failed expectation means the bug
happened. So one unchanged file serves as the repro, the proof of a fix, and
the regression test:

| verdict        | meaning                                                          |
|----------------|------------------------------------------------------------------|
| `REPRODUCED`   | an `expect` failed, or a built-in check tripped                  |
| `PASS`         | setup and check completed and every expectation held             |
| `INCONCLUSIVE` | the run never got as far as the question: an `assume` failed, setup threw, a probe or hook is missing from this build, or the session never came up |

`INCONCLUSIVE` must never count as a pass. Without that rule, a repro could
"prove" a fix it never exercised. `report.proof()` enforces this: the fixed ref
has to pass every run.

`assume` is for preconditions: "client1 is player 1", "the balance moved
someone". Use it for anything that has to be true for the check to mean
anything. Without it, a repro that silently drifts out of its scenario on a
later commit reads as `PASS`.

### 2. The repro goes in the issue (exists: `issue.js`)

A repro is a single CommonJS module, so the issue carries it as a fenced block
tagged `repro`:

````
```js repro
// #65 - the autobalance notice on the host names the wrong player.
module.exports = {
  issue: 65,
  title: '...',
  session: { clients: 2, map: 'ctf_truefort' },
  async setup({ server, assume }) { ... },
  async check({ server, expect, assume }) { ... },
};
```
````

GitHub still highlights `js repro` as JavaScript, and the `repro` word lets a
tool find the block without guessing. Add a section to the issue template:
"Repro script (optional) — paste a `js repro` block".

Most people who report bugs won't write one, and they shouldn't have to. In
practice a triager writes the repro from the issue text; an agent can draft it.
The reporter's job stays the same: describe what happened.

`node issue.js owner/repo#N` takes the most recent block in the thread out
into a file for `repro.js`. With `--as-of`, set to the time a maintainer asked
for the run, it ignores later posts and refuses a block edited since, so what
runs is what they read. `--json` gives the comment link, the author and their
role, and the script's sha256, for the report.

Repros declare which harness API version they were written against
(`harness: 1`). They outlive changes to the API, so the runner refuses one
written for another version instead of reinterpreting it.

### 3. A maintainer asks a bot to confirm it (by hand: exists; `/repro`: proposed)

**Exists: two workflows you start by hand** in this repo's Actions tab. Each
takes the latest `js repro` block from a thread of the game repo named by the
`TARGET_REPO` variable (or the `repo` input), runs it on a hosted Linux runner,
and posts the report back to that thread.

- **Confirm an issue** (`repro-issue.yml`): the issue's repro against a branch,
  `master` by default.
- **Prove a pull request** (`repro-pr.yml`): against the commit the pull
  request branched from, and its head (`--broken pr-N-base --fixed pr-N`). The
  repro comes from the pull request's thread, or else from the issue it closes.

Both call `repro.yml`, which is two jobs. `run` takes the script out of the
thread, as of the moment the workflow started, and runs it in the `linux/`
container with no network, no secrets, no capabilities and a read-only copy of
the game repo. `post` holds the only token that can comment
(`REPRO_BOT_TOKEN`: a fine-grained token for the game repo with Issues and Pull
requests write). It reads what `run` uploaded as text, and executes none of
it. Without that secret, the report is left in the run's summary instead.
Builds never leave the runner; only logs and the report are uploaded.

**Exists: `/repro` in a comment.** Events in the game repo can't reach a
workflow in this one, so **Answer /repro** (`repro-poll.yml`, `ci/poll.js`)
polls every 10 minutes. It starts one of the workflows above for each comment
that has a line starting `/repro`, outside code blocks, from a login in the
`REPRO_ALLOW` variable:

```
/repro                  run the thread's repro (on a pull request: prove it)
/repro runs=5           five runs, per side for a pull request (at most 10)
/repro ref=my-branch    on an issue: against that branch instead of master
```

The run uses the thread as of the `/repro` comment's own time, so a script
edited after it was read is refused. The bot reacts to show it has handled a
request: eyes when it started a run, confused when it could not parse the
request. Those reactions are the only state it keeps. Others' `/repro`
comments get no answer at all. An issue whose repro reproduces gets the
`repro-confirmed` label, which puts it in the nightly sweep (step 5).

**A repro is remote code execution, by design.** `server.eval` runs arbitrary
GML in the game, and the repro file itself is arbitrary Node. So:

- Never trigger on `issues: opened`, or on comments from people without write
  access. A maintainer reads the script before typing `/repro`.
- Run it in the testing fork (see step 5), which holds no secrets and no token
  that can write to upstream. Posting the result back upstream happens in a
  separate step, with a token that can only comment.
- Use a runner that can be thrown away.

**The runner needs a display and an audio device, and Linux can fake both.**
On Windows, GM8 needs an interactive, connected session. The `linux/` container
provides a virtual display and a null audio device under Wine instead, so a
hosted `ubuntu-latest` runner works (README.md, "Running on Linux"). Build the
game with `GM8_TEMPLATE` there, so that no Game Maker install has to go into
CI.

### 4. The fix PR proves itself (exists)

```
node repro.js repros/65-autobalance-notice-name.js --broken master --fixed my-fix-branch --runs 5
```

The report shows both sides: `REPRODUCED` on the base, `PASS` on the fix.
Paste it into the PR description. Seeing the change from REPRODUCED to PASS is
worth more to a reviewer than a single green check, because it shows the test
could fail at all.

The repro is named `<issue>-<slug>.js`. This repo does not track repros (only
`repros/example.js`), so where the kept ones live is part of step 5.

### 5. The corpus runs on its own (exists)

The corpus is the issues themselves: every issue labelled `repro-confirmed`.
**Nightly sweep** (`repro-nightly.yml`) runs each one's repro against the game
repo's default branch every night, once:

| issue | should | when it doesn't, the issue hears |
|---|---|---|
| open | REPRODUCE | "passes now": fixed by accident? |
| closed | PASS | "regression": it reproduces again |

A repro that no longer reaches a verdict is reported too. The sweep comments
only when the outcome is unexpected and differs from what its last comment
said, or when things are back to expected after one, so an ongoing
regression is reported once, not every night.

**The sweep runs only scripts a maintainer approved.** Anyone can post a new
`js repro` block into a labelled issue, so the sweep never takes the latest
one. Every report the bot posts ends in a hidden marker with the script's
sha256 and the time it was taken as of (`ci/comment.js`). The sweep finds the
bot's latest confirm report on the issue (`ci/sweep.js`), takes the thread as
of that time again, and refuses to run unless the script's hash matches. A
block that was edited after it was approved therefore can't be run. The
issue is told the repro needs asking for again with `/repro`.

To take an issue out of the sweep, remove the label.

### 6. Bisect (proposed)

`git bisect run` needs exit 0 for good, 1 for bad, and 125 for "can't test this
commit, skip it". Those map directly onto the verdicts:

| verdict        | bisect exit |
|----------------|-------------|
| `PASS`         | 0 (good)    |
| `REPRODUCED`   | 1 (bad)     |
| `INCONCLUSIVE` | 125 (skip)  |

`repro.js`'s own exit codes answer a different question, "did every ref
reproduce?", so this needs a small `--bisect` mode or wrapper that runs one ref
and returns the codes above:

```
cd ../Gang-Garrison-2
git bisect start <bad> <good>
git bisect run node ../gg2-automated-testing/repro.js repros/NNN.js --bisect --ref HEAD
```

Because a probe or hook that doesn't apply to a commit already makes the run
`INCONCLUSIVE`, bisect skips old commits the repro can't reach. It doesn't
blame them. A build takes about a minute and builds are cached by commit, so a
bisect over a few hundred commits costs roughly ten builds.

## Keeping repros trustworthy

- **Timing-dependent bugs get `--runs N` and a ratio.** "Reproduced 7/20" is
  an honest result. A single-run pass on a flaky bug is not. A fix is proven
  only when the broken side reproduces at least once and the fixed side passes
  every run, so use enough runs on the fixed side to mean it.
- **Set the state directly; don't play your way to it.** Where the game won't
  allow a state through normal play (a client can't join the bigger team, for
  example), set it on the server with `eval`. Then drive the behaviour under
  test through the game's own code, the way #65 calls `ServerBalanceTeams`
  itself. Repros stay deterministic, and they still test the real code path.
- **Assert on game state, not pixels.** Check names, teams, HP, positions and
  counts. Screenshots are evidence for the report, never the verdict.
- **Keep the built-in checks on.** `gmlError`, `desync` and `clientExit` run
  on every repro, so a repro for one bug also catches crashes it causes. Use
  `allow: [...]` only when the setup triggers an unrelated error on purpose,
  and say why in a comment.

## Later

- **Record-to-repro.** Log a player's per-frame inputs while they reproduce a
  bug by hand, and emit a skeleton repro that replays them. Someone then adds
  the `expect` by hand. This is Dolphin's FIFO-log approach. It lets people
  who report bugs contribute a repro without writing code, and it's the
  biggest single way to get more people using this.
- **Released binaries.** Repros currently need source to build from, because
  the bridge is injected into the tree. The game also loads `Plugins\*.gml` at
  startup (`loadplugins.gml`). If the bridge could load as a plugin instead, a
  repro could run against unmodified release `.exe`s. That would mean
  bisecting across releases without building anything. The catch: a plugin
  can't place hooks inside game scripts, so only repros that need no hooks
  would work this way.

## Labels

`needs-repro` → `repro-confirmed` (REPRODUCED on master) → fix merged with a
proof in the PR → repro kept in the corpus. Add `repro-flaky` for
ratio-only bugs, so they're watched rather than blocking anything.
