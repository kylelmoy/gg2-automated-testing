# gg2-automated-testing

An automated testing harness for Gang Garrison 2.
Reproduce a Gang Garrison 2 bug from a script, then prove a fix by running the
same script against the commit before it and the commit after it.

```powershell
node repro.js repros/example.js --broken master --fixed my-fix-branch --runs 3
```

```
### broken: `master` - REPRODUCED (3/3)
| 1 | REPRODUCED | the host's notice names the player who was moved: expected "client1", got "client2" | 12s |
...
### fixed: `my-fix-branch` - PASS (3/3)
...
[+] fix proven
```

A repro is one JavaScript file. It is small enough to paste into a GitHub
issue, and it runs unattended: the runner builds each commit, starts a
dedicated server and clients, drives them, reads their logs, and writes a
Markdown report that can be pasted into the issue or the PR.

## How it works

1. **Checkout.** Each ref is resolved in the source repo, and a detached git
   worktree of that commit is made under `.cache/` from a `--shared` clone. The
   source repo is only ever read, and nothing is injected into anyone's working
   copy.
2. **Inject.** The AgentBridge payload is copied into the worktree. It is a GML
   object that listens on a local TCP port and runs whatever it is sent. The
   repro's **hooks** go in with it.
   - A handful of **probes** rewrite single lines of the game so that failures
     it only ever puts on screen also reach a log. The main one is `desync`.
   - A probe whose anchor is not in this commit is recorded as missing, not
     treated as an error. This matters because the code moves: before #203
     there is no `clientProtocolError`, so the `desync` probe uses the older
     sites instead.
3. **Build.** The tree is built without anyone at the keyboard.
   `lib/gm8directbuild.js` runs Game Maker 8 on a desktop that is never
   displayed and calls the routine behind *File > Create Executable*. This
   takes about 10s. The result is cached per commit, hook set and payload.
4. **Run.** For each run, the runner starts a fresh dedicated server and
   clients from that build, on their own ports. Then it:
   - waits for the clients to join;
   - calls the repro's `setup()` and then its `check()`;
   - reads the logs;
   - tears the session down.

   Clients are named `client1`, `client2`, and so on, in the game too.
5. **Verdict.** Each run ends with one of three verdicts:
   - **REPRODUCED:** an expectation in `check()` failed, or a built-in check
     tripped. The built-in checks are a GML error, a client-side desync, and a
     client exiting unexpectedly.
   - **PASS:** setup and check both completed, and nothing tripped.
   - **INCONCLUSIVE:** the run never got to ask the question. Setup failed, a
     precondition (`assume`) did not hold, a needed probe or hook is not in
     this build, or the repro's own hook code raised an error. An
     inconclusive run is never counted as a pass.

   A fix is **proven** when the broken ref reproduces at least once and the
   fixed ref passes every run.

## Usage

```
node repro.js <repro.js> [--ref <ref>]...           run against one or more commits
node repro.js <repro.js> --broken <a> --fixed <b>    prove a fix
node repro.js <repro.js> --repo <built checkout>     run against an existing build

  --source <path>   the game repo refs are resolved in (default ../Gang-Garrison-2)
  --runs <n>        runs per ref; use more for timing-dependent bugs
  --out <dir>       results (default .cache/results/<repro>-<time>/)
  --rebuild         ignore the build cache
```

Each result directory holds `report.md`, `result.json`, and a `run<N>/` folder
for every run with every game's bridge and launcher logs.

**Exit codes:**
- With `--broken`/`--fixed`: `0` means the fix is proven.
- With `--ref`: `0` means every ref reproduced the bug.
- `2` means the tool itself failed.

`node test/selftest.js` checks the tooling offline in a few seconds. Run it
after changing anything under `lib/` or `payload/`.

## Layout

| | |
|---|---|
| `repro.js` | the command line |
| `lib/` | checkout, injection, headless build, sessions and the runner |
| `payload/` | the AgentBridge GML injected into every build |
| `repros/` | your repros. Only `example.js` is tracked; the rest of the folder is gitignored |
| `investigations/` | local notes on issues, gitignored |
| `docs/` | how to write a repro, and the issue-to-regression-test workflow |
| `test/selftest.js` | offline checks of the tooling |

## Writing a repro

See [docs/WRITING-REPROS.md](docs/WRITING-REPROS.md), and start from
[repros/example.js](repros/example.js) (#65, the autobalance notice naming the
wrong player): state set up on the server, then the game's own code run and
its result compared with `expect`.

Repros and investigations are kept out of this repo on purpose. Share a repro
by pasting it into the issue or the PR it belongs to.

## Setup

- Windows, Node 18+, and `npm install`.
- **Game Maker 8.0 Pro**, the exact build `lib/gm8directbuild.js` checks by
  sha256. Set `GM8_DIR` if auto-detection does not find it.
- **`vendor/gmksplit.exe`** (or `gmksplit.jar` with a JRE), and optionally
  `vendor/gm8x_fix.exe`. These are third-party binaries, so they are not
  committed. Build them from Medo42/Gmk-Splitter and skyfloogle/gm8x_fix.
- **An audio device and a connected desktop session.** GM8 needs both before
  any game code runs. Over RDP, turn on audio redirection, or use
  `tscon <id> /dest:console`.

## The bridge

`payload/` is a Game Maker object and a set of scripts. Injected into a build,
it listens on a loopback TCP port and runs whatever GML it is sent. It accepts
only local connections, and one client at a time. Some details:

- Games are started with `-agentfailfast`. A client that detects a desync then
  aborts and is seen to exit, instead of offering to restart itself.
- The runner only ever stops games whose executable is in its own build
  directories. The server hosts on port 8290, so a game on the default 8190 is
  left alone.
- `lib/launcher.js` stays resident beside each game. It dismisses GM8's modal
  dialogs (runtime errors, `show_message`) and logs what they said. A GML error
  therefore does not freeze a run, and it still reaches the report.

The bridge runs any GML it is sent, so **never let a build from `.cache/` out
of this machine.**

## Not built yet

[docs/WORKFLOW.md](docs/WORKFLOW.md) covers the process from issue to
regression test. That includes the proposed pieces: the `/repro` bot, a
nightly run of `repros/`, and `--bisect`. In addition:

- **Uncommitted changes.** `--ref` builds commits only; there is no mode yet
  for a working tree with uncommitted changes.
- **Recording and replaying the wire.** A TCP proxy between client and server
  that records the stream, so a client-side parsing bug can be replayed
  deterministically without a server.
