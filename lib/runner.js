//=============================================================================
// runner.js - run one repro against one built game, and decide what happened.
//
// A run is: start a fresh session, wait for every client to be in the server's
// player list, run the repro's setup(), run its check(), look at the logs,
// stop the session. Each run gets its own session so runs cannot leak state
// into each other.
//
// VERDICTS. The point of a repro is to tell "the bug happened" apart from "the
// bug did not happen" - and both apart from "the test never got as far as
// asking", which is what a failed setup or a missing probe means. Calling that
// third case a pass is how a repro would come to "prove" a fix it never
// exercised, so it has a verdict of its own:
//
//   REPRODUCED    check() failed an expectation, or a built-in check tripped
//   PASS          setup and check completed, every expectation held, and
//                 nothing tripped
//   INCONCLUSIVE  setup() threw, check() threw something that is not a failed
//                 expectation (a timeout, a bridge error) with nothing tripped,
//                 a probe or hook the repro needs is not in this build, or the
//                 session never came up
//
// BUILT-IN CHECKS run on every repro, over the whole run:
//   gmlError      the launcher dismissed a GML error dialog (E|) in any game
//   desync        a client logged DESYNC (needs the `desync` probe)
//   clientExit    a client's process ended without the repro stopping it
// A repro can opt out of one with `allow: ['gmlError']` - for a bug whose
// symptom is some other thing and whose setup provokes an unrelated error.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');
const instances = require('./instances.js');
const { Bridge, BridgeError } = require('./bridge.js');
const { Session } = require('./session.js');
const { buildDirOf, readRecord } = require('./build.js');

class ExpectationFailed extends Error {}
class GameError extends Error {}
// Thrown by t.assume(): the run did not reach the state the check is about.
class Unmet extends Error {}

const BUILT_IN = ['gmlError', 'desync', 'clientExit'];

//---------------------------------------------------------------------------
// Logs
//---------------------------------------------------------------------------

// The dialogs a launcher log records, as { mark, text } - one per dialog, its
// lines joined. The launcher writes each line of a dialog as "<stamp>   E| ..."
// and then a "dismissed ..." line.
function dialogsIn(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  let cur = null;
  for (const line of lib.readText(file).split(/\r?\n/)) {
    const m = /^\d{14}\s+([EM]!?)\| (.*)$/.exec(line);
    if (m) {
      if (!cur) cur = { mark: m[1][0], lines: [] };
      cur.lines.push(m[2]);
    } else if (cur) {
      out.push({ mark: cur.mark, text: cur.lines.join(' / ') });
      cur = null;
    }
  }
  if (cur) out.push({ mark: cur.mark, text: cur.lines.join(' / ') });
  return out;
}

function bridgeLines(file, pattern) {
  if (!fs.existsSync(file)) return [];
  return lib
    .readText(file)
    .split(/\r?\n/)
    .filter((l) => pattern.test(l))
    .map((l) => l.replace(/^\d+\s+/, ''));
}

//---------------------------------------------------------------------------
// One game, as a repro sees it
//---------------------------------------------------------------------------

// GM8 piles repeats of an error into one dialog while it is up; keep one copy,
// and not all of it.
function clip(text, max = 400) {
  const blocks = [...new Set(text.split(/_{20,}/).map((b) => b.replace(/^[\s/]+|[\s/]+$/g, '')).filter(Boolean))];
  const one = blocks.join(' || ');
  return one.length > max ? one.slice(0, max) + '...' : one;
}

const gmlString = (s) => '"' + String(s).replace(/"/g, '" + chr(34) + "') + '"';

class Game {
  constructor(buildDir, member) {
    this.name = member.name;
    this.role = member.role;
    this.port = member.port;
    this.buildDir = buildDir;
    this.bridge = new Bridge(member.port);
    this.launcherLog = instances.launcherLog(buildDir, member.port);
    this.bridgeLog = instances.bridgeLog(buildDir, member.port);
    this.ownErrors = new Set(); // indices into errors() that a repro call caused
  }

  errors() {
    return dialogsIn(this.launcherLog).filter((d) => d.mark === 'E');
  }

  // Every call goes through here. A call that runs GML at once - EVAL, EVALX -
  // and makes the game raise an error fails with the game's own text, and that
  // error is the repro's, not the game's: it is left out of the built-in
  // gmlError check. The launcher dismisses the dialog before the bridge can
  // reply, so by the time a reply arrives the error is already in its log.
  //
  // WAIT and STEP run the game for many frames, so an error during one is
  // the game's own doing - possibly the bug - and is left for the built-in
  // check, unless the bridge says it was the WAIT expression that raised.
  async request(request, timeoutMs) {
    const verb = request.split(' ')[0];
    const immediate = verb !== 'WAIT' && verb !== 'STEP';
    const before = this.errors().length;
    let reply;
    let failure = null;
    try {
      reply = await this.bridge.call(request, timeoutMs);
    } catch (e) {
      failure = e;
    }
    const errs = this.errors().slice(before);
    const ours = immediate || (failure && /expression raised/.test(failure.message));
    if (errs.length && ours) {
      for (let i = before; i < before + errs.length; i++) this.ownErrors.add(i);
      const said = errs.map((d) => clip(d.text)).join('\n  ');
      throw new GameError(`${this.name}: the game raised an error during ${verb}:\n  ${said}`);
    }
    if (failure) throw new BridgeError(`${this.name}: ${failure.message}`);
    return reply;
  }

  // Run GML for its side effects.
  async eval(code) {
    await this.request('EVAL ' + code.trim());
  }

  // The value of a GML expression, as the game's string() renders it.
  async evalx(expr) {
    return this.request('EVALX ' + expr.trim().replace(/;\s*$/, ''));
  }

  // evalx, as a number.
  async num(expr) {
    const v = Number(await this.evalx(expr));
    if (!Number.isFinite(v)) throw new GameError(`${this.name}: ${expr} is not a number`);
    return v;
  }

  // Run until `expr` is true, tested inside the game once a frame. Returns how
  // many frames that took; throws if it is still false after `frames`.
  async waitFor(expr, { frames = 300, setup = '' } = {}) {
    expr = expr.trim().replace(/;\s*$/, '');
    const budget = Math.max(1, Math.min(3600, frames));
    const reply = await this.request(`WAIT ${budget} ${setup.length}:${setup}${expr}`, (budget / 30) * 1000 * 3 + 10000);
    return Number((/after (\d+)/.exec(reply) || [])[1]);
  }

  // Let the game run for n frames (up to 3600), measured by the game itself.
  async idle(frames) {
    const reply = await this.bridge.raw(`WAIT ${Math.max(1, Math.min(3600, frames))} 0:false`, (frames / 30) * 1000 * 3 + 10000);
    if (!/^ERR still false/.test(reply)) throw new GameError(`${this.name}: idle did not run its frames: ${reply}`);
  }

  // Freeze, then advance exactly n frames. The world stays frozen afterwards.
  // Freezing stops the objects that service the network, so a long freeze
  // inside a session will drop clients.
  async step(n = 1) {
    await this.request('FREEZE');
    await this.request(`STEP ${n}`, (n / 30) * 1000 * 3 + 10000);
  }

  async resume() {
    await this.request('RESUME');
  }

  // press/release left|right|up|jump|down|taunt, or any other key as a tap.
  async input(commands) {
    await this.request('INPUT ' + commands.trim());
  }

  // Run faster (or slower) than real time. Not sticky: step, waitFor and
  // resume put it back to normal.
  async speed(factor) {
    await this.request('SPEED ' + factor);
  }

  // Arm a hook the repro declared: `code` runs every time the game reaches
  // that site, until disarmed. Disarm from inside the code for "once":
  // ds_map_delete(global.agentHooks, "<name>").
  async arm(hook, code) {
    // ds_map_replace does not add a missing key in GM8, and ds_map_add does not
    // overwrite an existing one, so delete first.
    await this.eval(
      `ds_map_delete(global.agentHooks, ${gmlString(hook)}); ds_map_add(global.agentHooks, ${gmlString(hook)}, ${gmlString(code)}); ` +
        `ds_map_delete(global.agentHookSeen, ${gmlString(hook)});`
    );
  }

  async disarm(hook) {
    await this.eval(`ds_map_delete(global.agentHooks, ${gmlString(hook)});`);
  }

  // A screenshot, saved into the run's evidence directory.
  async screenshot(file) {
    return this.request('SHOT ' + file, 20000);
  }

  // Lines this game's bridge log has that match `pattern` (HOOK, DESYNC, ...).
  logLines(pattern) {
    return bridgeLines(this.bridgeLog, pattern);
  }
}

//---------------------------------------------------------------------------
// Expectations
//---------------------------------------------------------------------------

function makeExpect(record) {
  const fail = (msg) => {
    record.push({ ok: false, message: msg });
    throw new ExpectationFailed(msg);
  };
  const pass = (msg) => record.push({ ok: true, message: msg });
  const show = (v) => JSON.stringify(v);
  return {
    ok(cond, message) {
      if (!cond) fail(message);
      pass(message);
    },
    equal(actual, expected, message) {
      if (String(actual) !== String(expected)) fail(`${message}: expected ${show(expected)}, got ${show(actual)}`);
      pass(message);
    },
    notEqual(actual, other, message) {
      if (String(actual) === String(other)) fail(`${message}: both were ${show(actual)}`);
      pass(message);
    },
    near(actual, expected, tolerance, message) {
      if (Math.abs(Number(actual) - Number(expected)) > tolerance) {
        fail(`${message}: expected ${expected} +/- ${tolerance}, got ${actual}`);
      }
      pass(message);
    },
    fail,
  };
}

//---------------------------------------------------------------------------
// Loading a repro
//---------------------------------------------------------------------------

function load(file) {
  const full = path.resolve(file);
  delete require.cache[full];
  const repro = require(full);
  if (typeof repro.check !== 'function') throw new Error(`${file} has no check() - see docs/WRITING-REPROS.md`);
  const session = { clients: 1, map: 'ctf_truefort', ...(repro.session || {}) };
  return {
    file: full,
    title: repro.title || path.basename(file),
    issue: repro.issue || null,
    session,
    needs: repro.needs || [],
    hooks: repro.hooks || {},
    allow: repro.allow || [],
    timeoutSeconds: repro.timeoutSeconds || 180,
    setup: repro.setup || (async () => {}),
    check: repro.check,
  };
}

//---------------------------------------------------------------------------
// Running it
//---------------------------------------------------------------------------

const withTimeout = (promise, ms, what) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new BridgeError(`${what} did not finish within ${ms / 1000}s`)), ms);
    }),
  ]);
};

// Run `repro` (a loaded repro) once against the game built in `repo`.
async function runOnce({ repro, repo, evidenceDir, basePort = 18777, hostingPort = 8290, quiet = false }) {
  const buildDir = buildDirOf(repo);
  const record = readRecord(repo) || {};
  const result = {
    verdict: null,
    reason: '',
    phase: 'start',
    expectations: [],
    tripped: [],
    notes: [],
    error: null,
    seconds: 0,
  };
  const started = Date.now();
  const say = (m) => lib.detail(m);

  // --- can this build answer the question at all? ---------------------------
  const probes = record.probes || {};
  const missingProbes = repro.needs.filter((p) => !probes[p]);
  const missingHooks = Object.keys(repro.hooks).filter((h) => !(record.hooks && record.hooks[h] && record.hooks[h].landed));
  if (missingProbes.length || missingHooks.length) {
    result.verdict = 'INCONCLUSIVE';
    result.reason = [
      missingProbes.length ? `this build lacks probe(s) ${missingProbes.join(', ')}` : '',
      missingHooks.length
        ? `hook(s) not placed: ${missingHooks.map((h) => `${h} (${(record.hooks && record.hooks[h] && record.hooks[h].error) || 'not built with it'})`).join('; ')}`
        : '',
    ].filter(Boolean).join('; ');
    return result;
  }
  const checks = BUILT_IN.filter((c) => !repro.allow.includes(c)).filter((c) => c !== 'desync' || probes.desync);
  if (!probes.desync && !repro.allow.includes('desync')) {
    result.notes.push('this build has no desync probe, so a desync is only seen if it causes a GML error or an exit');
  }

  const session = new Session({ repo, map: repro.session.map, basePort, hostingPort, quiet: true });
  const games = [];
  const left = new Set(); // clients the repro stopped on purpose
  let t;

  const gameFor = (member) => {
    const g = new Game(buildDir, member);
    games.push(g);
    return g;
  };

  try {
    // --- session -----------------------------------------------------------
    result.phase = 'session';
    say(`starting a server and ${repro.session.clients} client(s) on ${repro.session.map}`);
    const members = await session.start({ clients: repro.session.clients });
    const server = gameFor(members[0]);
    const clients = members.slice(1).map(gameFor);

    // Every game is started with -agentfailfast (session.js): a client that
    // desyncs aborts rather than offering Restart, which would replace the
    // process being watched.
    if (repro.session.seed !== undefined) {
      for (const g of games) await g.eval(`random_set_seed(${Number(repro.session.seed)});`);
    }

    // Player 0 is the server's own; every client is one more.
    await server.waitFor(`ds_list_size(global.players) >= ${1 + clients.length}`, { frames: 900 });

    t = {
      server,
      clients,
      client: (name) => games.find((g) => g.name === name) || null,
      async join() {
        return gameFor(await session.join());
      },
      async leave(game) {
        left.add(game.name);
        game.bridge.close();
        await session.stop(game.name);
      },
      expect: makeExpect(result.expectations),
      // A precondition, not an expectation: when it does not hold, the run never
      // reached the situation the bug is about, which is INCONCLUSIVE, not a pass
      // and not a reproduction.
      assume(cond, message) {
        if (!cond) throw new Unmet(message);
      },
      log: (m) => {
        result.notes.push(String(m));
        say(String(m));
      },
      sleep: lib.sleep,
      evidence: evidenceDir,
      async screenshot(game, label) {
        const file = path.join(evidenceDir, `${game.name}-${label}.bmp`);
        await game.screenshot(file);
        return file;
      },
    };

    // --- setup -------------------------------------------------------------
    result.phase = 'setup';
    await withTimeout(repro.setup(t), repro.timeoutSeconds * 1000, 'setup');

    // --- check -------------------------------------------------------------
    result.phase = 'check';
    await withTimeout(repro.check(t), repro.timeoutSeconds * 1000, 'check');
    result.phase = 'done';
  } catch (e) {
    result.error = { phase: result.phase, type: e.constructor.name, message: e.message };
  }

  // --- built-in checks -------------------------------------------------------
  // Give the launchers a moment to write down a dialog the last call caused.
  await lib.sleep(500);
  for (const g of games) {
    if (checks.includes('gmlError')) {
      g.errors().forEach((d, i) => {
        if (!g.ownErrors.has(i)) result.tripped.push({ check: 'gmlError', game: g.name, text: clip(d.text) });
      });
    }
    if (checks.includes('desync') && g.role === 'client') {
      for (const line of g.logLines(/\bDESYNC\b/)) result.tripped.push({ check: 'desync', game: g.name, text: line });
    }
    if (checks.includes('clientExit') && g.role === 'client' && !left.has(g.name) && !session.alive(g.name)) {
      result.tripped.push({ check: 'clientExit', game: g.name, text: `${g.name} exited` });
    }
  }
  const seen = new Set();
  result.tripped = result.tripped.filter((x) => {
    const k = `${x.check}|${x.game}|${x.text}`;
    return seen.has(k) ? false : seen.add(k);
  });
  // A hook that raised is the repro's own mistake. agentHook disarms it and
  // logs HOOKERROR; whatever it went on to cause proves nothing about the game.
  const hookErrors = games.flatMap((g) => g.logLines(/HOOKERROR/).map((l) => `${g.name}: ${l}`));

  // --- evidence and teardown -------------------------------------------------
  for (const g of games) g.bridge.close();
  // Every game's logs, including one that died before it could be driven.
  const nameOf = new Map(session.members.map((m) => [m.port, m.name]));
  for (const f of fs.readdirSync(buildDir)) {
    const m = /^agent_(?:bridge|launcher)_(\d+)\.log$/.exec(f);
    if (!m) continue;
    const who = nameOf.get(Number(m[1])) || `port${m[1]}`;
    fs.copyFileSync(path.join(buildDir, f), path.join(evidenceDir, `${who}-${f}`));
  }
  await session.stop();

  // --- verdict ---------------------------------------------------------------
  const failedExpectation = result.error && result.error.type === 'ExpectationFailed';
  if (hookErrors.length) {
    result.verdict = 'INCONCLUSIVE';
    result.reason = `the repro's hook code raised an error - ${hookErrors[0]}`;
  } else if (result.error && result.error.type === 'Unmet') {
    result.verdict = 'INCONCLUSIVE';
    result.reason = `precondition not met in ${result.error.phase}: ${result.error.message}`;
  } else if (result.error && (result.error.phase === 'session' || result.error.phase === 'setup')) {
    result.verdict = 'INCONCLUSIVE';
    result.reason = `${result.error.phase} did not complete: ${result.error.message}`;
    if (result.tripped.length) result.notes.push('built-in checks tripped before check() ran - see tripped');
  } else if (failedExpectation) {
    result.verdict = 'REPRODUCED';
    result.reason = result.error.message;
  } else if (result.tripped.length) {
    result.verdict = 'REPRODUCED';
    // A desync is the cause when it is there; the abort it triggers and the exit
    // that follows are consequences, so name the desync.
    const order = ['desync', 'gmlError', 'clientExit'];
    const first = [...result.tripped].sort((a, b) => order.indexOf(a.check) - order.indexOf(b.check))[0];
    result.reason = `${first.check} on ${first.game}: ${first.text}`;
  } else if (result.error) {
    result.verdict = 'INCONCLUSIVE';
    result.reason = `check did not complete: ${result.error.message}`;
  } else {
    result.verdict = 'PASS';
    result.reason = `${result.expectations.length} expectation(s) held, no built-in check tripped`;
  }
  result.seconds = Math.round((Date.now() - started) / 1000);
  return result;
}

// Run `repro` `runs` times against one build, and summarise.
async function runAll({ repro, repo, runs = 1, outDir, basePort, hostingPort, quiet = false }) {
  const record = readRecord(repo) || {};
  const results = [];
  for (let i = 1; i <= runs; i++) {
    const evidenceDir = path.join(outDir, `run${i}`);
    fs.mkdirSync(evidenceDir, { recursive: true });
    lib.step(`run ${i}/${runs}`, quiet);
    const r = await runOnce({ repro, repo, evidenceDir, basePort, hostingPort, quiet });
    lib[r.verdict === 'INCONCLUSIVE' ? 'warn' : 'ok'](`${r.verdict}: ${r.reason}`);
    results.push(r);
    if (r.verdict === 'INCONCLUSIVE' && /lacks probe|hook\(s\) not placed/.test(r.reason)) break; // every run would say the same
  }
  const count = (v) => results.filter((r) => r.verdict === v).length;
  return {
    ref: record.ref || null,
    sha: record.key ? record.key.sha : null,
    subject: record.subject || null,
    repo,
    probes: record.probes || {},
    runs: results,
    reproduced: count('REPRODUCED'),
    passed: count('PASS'),
    inconclusive: count('INCONCLUSIVE'),
  };
}

module.exports = { load, runOnce, runAll, dialogsIn, Game, ExpectationFailed, GameError };
