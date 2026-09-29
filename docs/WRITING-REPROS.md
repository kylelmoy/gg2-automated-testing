# Writing a repro

A repro is a CommonJS module:

```js
module.exports = {
  harness: 1,                               // the repro API this was written for
  issue: 65,                                // optional, shown in the report
  title: 'What goes wrong, in one line',
  session: { clients: 2, map: 'ctf_truefort', seed: 1 },
  needs: ['desync'],                        // probes the verdict depends on
  hooks: { ... },                           // code sites to run GML at, see below
  allow: [],                                // built-in checks to switch off
  timeoutSeconds: 180,                      // per phase

  async setup(t) { /* get to the situation the bug is about */ },
  async check(t) { /* make it happen, and say what should be true */ },
};
```

`harness` names the version of this API the repro was written for. A runner
refuses a repro written for a version it does not implement, rather than
guessing at what it meant. Leaving it out means 1, but a repro that goes into
an issue should say so.

To share a repro, paste it into the issue as a fenced block tagged `js repro`.
`node issue.js owner/repo#N` takes the most recent such block in the thread
back out into a file for `repro.js`.

The rules that decide the verdict:

- **`setup` gets to the situation. `check` asks the question.** An exception
  in `setup` gives INCONCLUSIVE, because the question was never asked.
- **`t.expect.*` is the question.** A failed expectation gives REPRODUCED.
- **`t.assume(cond, msg)` is a precondition,** usable in either phase. If it
  does not hold, the run did not reach the case the bug is about, so the
  verdict is INCONCLUSIVE. Use it for anything that would otherwise let a
  broken repro pass: "the sentry was actually built", "client1 really is
  player 1".
- **The built-in checks run on every repro** unless listed in `allow`:
  - `gmlError`: the game raised a GML error. Errors raised by the repro's own
    `eval`/`evalx` calls are excluded; those calls throw instead.
  - `desync`: a client detected a stream desync. Needs the `desync` probe.
  - `clientExit`: a client process ended without `t.leave()`.

  Any of these gives REPRODUCED. For a desync or a crash, the built-in checks
  are often all the check you need.

## What `t` has

| | |
|---|---|
| `t.server`, `t.clients` | the games; `t.client('client2')` looks one up by name |
| `await t.join()` | start one more client; resolves when its bridge is up, before it has joined |
| `await t.leave(game)` | stop a client on purpose (it will not count as `clientExit`) |
| `t.expect.equal / notEqual / ok / near / fail` | expectations |
| `t.assume(cond, msg)` | preconditions |
| `t.log(msg)` | a note in the report |
| `await t.screenshot(game, label)` | saved to the run's evidence directory |

Each game has these methods:

| | |
|---|---|
| `await g.eval(gml)` | run GML. A GML error throws, with the game's own text |
| `await g.evalx(expr)` / `g.num(expr)` | the value of an expression, as a string or a number |
| `await g.waitFor(expr, { frames })` | tested inside the game every frame; throws if still false |
| `await g.idle(frames)` | let the game run for exactly that many of its own frames |
| `await g.step(n)` / `g.resume()` | freeze and single-step. Freezing stops the networking too, so in a session it drops clients |
| `await g.input('press left')` | held keys: `left right up jump down taunt`; anything else is a tap |
| `await g.speed(factor)` | faster than real time, until the next `waitFor`/`idle`/`step` |
| `await g.arm(hook, gml)` / `g.disarm(hook)` | see hooks |
| `g.logLines(/regex/)` | lines of this game's bridge log |

Player 0 in `global.players` is always the server's own player. The clients
come after it, in the order they joined.

## Hooks

A hook runs GML **inside a specific line of the game's own code**, in the same
frame. A call from outside the game arrives one or two frames late, so a hook
is the only way to hit a bug that lives in a single tick.

```js
hooks: {
  afterJoin: { file: 'Scripts/GameServer/serviceJoiningPlayer.gml', after: 'ServerJoinUpdate(socket);' },
  onDeath:   { object: 'Character', event: 'Destroy', before: 'someLine();' },
},
```

- **Where the hook goes.** The runner inserts `agentHook("afterJoin");` next to
  the named line before it builds. Each hook set makes its own cached build.
- **Arming.** Nothing runs until a game arms the hook with
  `await t.server.arm('afterJoin', gml)`. The code then runs every time that
  line is reached. To make it run once, disarm from inside it:
  `ds_map_delete(global.agentHooks, "afterJoin");`.
- **Anchors.** The anchor must be exactly one line of that file, compared with
  whitespace trimmed. The runner refuses a placement that would change what the
  game does, which means next to the braceless body of an `if`/`else`/`with`.
  A hook that could not be placed makes the run INCONCLUSIVE, with the reason.
- **What the hook code can see.** It runs as whatever instance is executing
  that line, and it **cannot see the surrounding script's `var` locals**. Reach
  things through globals instead, for example
  `ds_list_find_value(global.players, 1)`.
- **Errors in hook code.** Hook code that raises an error is disarmed after the
  first time. The run is INCONCLUSIVE, because it is the repro's mistake, not
  the game's.
- **Evidence.** `HOOK <name>` is logged the first time a hook fires.

## GML reminders

This is Game Maker 8. It has no `?:`, no `try`, no structs, and no string
escapes (use `chr(34)` for a quote). Use `and`/`or`/`not`. `ds_map_replace`
does not add a missing key. A deactivated instance cannot be read while the
game is frozen. Constants such as `TEAM_RED` and `CLASS_ENGINEER` work inside
eval'd code.

## Rigging state

Setting state directly (`p.team = TEAM_RED` on the server) is fine when the
real route to that state is not what the bug is about, and the game sometimes
forbids the real route: a client cannot join the bigger team. Say so in the
header comment, and still run the part the bug is about through the game's own
code.
