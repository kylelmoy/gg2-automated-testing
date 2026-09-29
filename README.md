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
3. **Build.** [gm8-builder](https://github.com/kylelmoy/gm8-builder) packs
   the tree straight into an executable, with gm8x_fix's patches, and no Game
   Maker process. This takes a few seconds. The result is cached per commit,
   hook set, payload and gm8-builder version.
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

A ref is anything the source repo resolves (a branch, a tag, a sha), or
pull/<n> for a pull request's head. That is fetched from the source's origin
into the cache's own clone, never into the source repo.

node issue.js <owner/repo#N>                         write an issue's repro to a file
```

Repros shared in issues travel as a fenced block tagged `js repro`. `issue.js`
takes the most recent one in the thread back out; `--as-of <time>` ignores
later posts and refuses a block edited since. The whole round trip:

```bash
node repro.js "$(node issue.js owner/Gang-Garrison-2#65)" --broken master --fixed pull/70
```

Each result directory holds `report.md`, `result.json`, and a `run<N>/` folder
for every run with every game's bridge and launcher logs.

**Running several at once.** Runs share nothing if each gets its own cache,
bridge ports and hosting port:

```bash
GG2_TEST_CACHE=.cache/slot1 node repro.js a.js --port 19100 --hosting-port 8400
GG2_TEST_CACHE=.cache/slot2 node repro.js b.js --port 19200 --hosting-port 8410
```

A cache holds one build per commit, and a session stops every game in its
build directory when it starts, so two runs in the same cache would stop each
other's games.

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
| `lib/` | checkout, injection, build, sessions and the runner |
| `payload/` | the AgentBridge GML injected into every build |
| `repros/` | your repros. Only `example.js` is tracked; the rest of the folder is gitignored |
| `investigations/` | local notes on issues, gitignored |
| `docs/` | how to write a repro, and the issue-to-regression-test workflow |
| `linux/` | the container for running on Linux, and `gamewatch.exe` |
| `test/selftest.js` | offline checks of the tooling |

## Writing a repro

See [docs/WRITING-REPROS.md](docs/WRITING-REPROS.md), and start from
[repros/example.js](repros/example.js) (#65, the autobalance notice naming the
wrong player): state set up on the server, then the game's own code run and
its result compared with `expect`.

Repros and investigations are kept out of this repo on purpose. Share a repro
by pasting it into the issue or the PR it belongs to.

## Setup

- Windows, Node 18+, and `npm install`. Or Linux with Docker; see "Running on Linux".
- **Game Maker 8.0's data files** (`rundata`, `dxdata`, `lib/`, `extensions/`),
  from an install or a copy of just those. Set `GM8_DIR` if auto-detection does
  not find them.
- **gm8-builder**, which is not part of this repo. The release pinned in
  `lib/gm8builder.js` is downloaded into `.cache/tools` on first use and
  checked by sha256. To use another build of it, set `GM8_BUILDER` to its exe.
- **An audio device and a connected desktop session.** GM8 needs both before
  any game code runs. Over RDP, turn on audio redirection, or use
  `tscon <id> /dest:console`.

## Running on Linux

The game runs under Wine in a container, with a fake display and a fake audio
device. This is what CI uses. `linux/Dockerfile` has Wine, Xvfb, a PulseAudio
null sink, Node, and `gamewatch.exe`: the launcher's dialog clearing rewritten
as a Win32 program, because only a Windows program can see a Wine program's
dialogs.

```bash
docker build -t gg2-test linux
docker run --rm --init \
  -v "$PWD":/work -v "$PWD/../Gang-Garrison-2":/Gang-Garrison-2 \
  -v /path/to/template.exe:/template.exe:ro -e GM8_TEMPLATE=/template.exe \
  gg2-test node repro.js repros/example.js --broken master --fixed my-fix-branch --runs 3
```

- **`--init` is required.** The runner kills Wine processes, and something
  has to reap them.
- **Game Maker's files.** Set `GM8_DIR` to a copy of GM8's data files, as on
  Windows, or set `GM8_TEMPLATE` to any GM8 build of the game. gm8-builder then
  takes the runner and its DLL from that exe, and no Game Maker install is
  needed. The official release works: `Gang Garrison 2.exe` from
  `https://www.ganggarrison.com/download.php?file=1` (v2.9.2, sha256
  `7eb15834...d9d645`). The template is part of the build cache key. On either
  platform, the extensions come from each commit's own `Extensions/*.gex`.
- **The first run needs the network**, to download gm8-builder into
  `.cache/tools`. After that, `--network none` works.
- **Another uid.** The image's Wine prefix belongs to uid 1000. Run as anyone
  else (`--user`), and the entrypoint copies the prefix for that user first.
  Git then also needs `safe.directory` for the mounted repos.
- **Slower than Windows.** A game takes about 7s to start, against about 3s on
  Windows, so the example repro takes about 28s a run instead of 12s. Each game
  uses most of a core while it draws, in software. Four cores fit a server
  and two clients.

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
  therefore does not freeze a run, and it still reaches the report. Under
  Wine, `linux/gamewatch.exe` does the clicking and the launcher logs what it
  reports.

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
