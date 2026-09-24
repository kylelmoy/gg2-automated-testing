//=============================================================================
// build.js - build a game tree, with the bridge injected, into an executable.
//
// Unattended, start to finish:
//
//   1. inject      the bridge, the probes and a repro's hooks
//   2. gmksplit    reassemble Source/gg2 into a .gmk
//   3. Game Maker  create the executable, headlessly (gm8directbuild.js)
//   4. gm8x_fix    patch the executable, if the patcher is available
//   5. record      what landed, in agent_build.json beside the exe
//
// There is no fallback to a person clicking File > Create Executable, and no
// cleanup step: this only ever runs on a worktree checkout.js owns, which it
// resets with git before the next build.
//=============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib.js');
const { inject } = require('./inject.js');
const gm8directbuild = require('./gm8directbuild.js');

const GAME_IMAGE = 'Gang Garrison 2.exe';
const BUILD_RECORD = 'agent_build.json';
const VENDOR = path.resolve(__dirname, '..', 'vendor');

const buildDirOf = (repo) => path.join(path.resolve(repo), 'Source', 'build');

// gmksplit.exe is a launch4j wrapper around gmksplit.jar, so either will do;
// the jar needs a JRE on PATH.
function resolveSplitter() {
  const exe = path.join(VENDOR, 'gmksplit.exe');
  if (fs.existsSync(exe)) return { exe, args: [] };
  const jar = path.join(VENDOR, 'gmksplit.jar');
  if (fs.existsSync(jar)) return { exe: 'java', args: ['-jar', jar] };
  throw new Error(`neither gmksplit.exe nor gmksplit.jar is in ${VENDOR} - see README.md, "Setup"`);
}

// Quality fixes to a game that already runs (input lag, scheduler, ...), so a
// build without it still works.
function resolveGm8xFix() {
  const exe = path.join(VENDOR, 'gm8x_fix.exe');
  if (fs.existsSync(exe)) return exe;
  lib.warn(`gm8x_fix.exe is not in ${VENDOR} - building without it`);
  return null;
}

const readRecord = (repo) => {
  const file = path.join(buildDirOf(repo), BUILD_RECORD);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};

// One Game Maker at a time on the whole machine. Runs with separate caches
// (GG2_TEST_CACHE) and ports can go side by side, but a second IDE starting
// while one is building can find the first one's temp folder and ask whether
// to remove it - a dialog nobody can answer on a hidden desktop. The lock is a
// directory (mkdir is atomic) holding its owner's pid, so a lock left by a
// process that died is taken over rather than waited on.
const GM8_LOCK = path.join(os.tmpdir(), 'gg2-automated-testing-gm8.lock');

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

async function withGm8Lock(fn, { timeoutMinutes = 20, quiet = false } = {}) {
  const owner = path.join(GM8_LOCK, 'pid');
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  let said = false;
  for (;;) {
    try {
      fs.mkdirSync(GM8_LOCK);
      fs.writeFileSync(owner, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = NaN;
      try {
        pid = Number(fs.readFileSync(owner, 'utf8'));
      } catch (_) {
        // Just made, pid not written yet - or left empty by a crash. Only
        // the second is stale, and only an old directory can be that.
        try {
          if (Date.now() - fs.statSync(GM8_LOCK).mtimeMs < 10000) pid = -1;
        } catch (_) {
          continue; // released between the two calls
        }
      }
      if (pid !== -1 && !(pid > 0 && pidAlive(pid))) {
        fs.rmSync(GM8_LOCK, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`waited ${timeoutMinutes} min for another build to release ${GM8_LOCK}`);
      if (!said) lib.step('Waiting for another Game Maker build to finish', quiet);
      said = true;
      await lib.sleep(1000);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(GM8_LOCK, { recursive: true, force: true });
  }
}

async function build({ repo, hooks = {}, record = {}, gm8Dir = null, quiet = false }) {
  const repoFull = path.resolve(repo);
  const source = path.join(repoFull, 'Source');
  const buildDir = buildDirOf(repoFull);
  const exeOut = path.join(buildDir, GAME_IMAGE);
  const gmkOut = path.join(buildDir, 'gg2.gmk');

  const gmksplit = resolveSplitter();
  const gm8x = resolveGm8xFix();

  const injected = inject(repoFull, { hooks, quiet });

  // Only games running from this directory hold it; nothing else is touched.
  await lib.stopGamesIn(buildDir, GAME_IMAGE);
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  lib.step('Reassembling the source tree', quiet);
  await lib.run(gmksplit.exe, [...gmksplit.args, 'gg2', path.join('build', 'gg2.gmk')], source);
  if (!fs.existsSync(gmkOut)) throw new Error(`gmksplit produced no ${gmkOut}`);

  lib.step('Building headlessly', quiet);
  let started;
  await withGm8Lock(() => {
    started = Date.now();
    return gm8directbuild.buildExe({ gmk: gmkOut, exe: exeOut, gm8: gm8Dir, timeoutMinutes: 5, log: quiet ? () => {} : lib.detail });
  }, { quiet });
  lib.ok(`built in ${((Date.now() - started) / 1000).toFixed(0)}s (${fs.statSync(exeOut).size} bytes)`, quiet);

  if (gm8x) await lib.run(gm8x, ['-nb', '-s', exeOut], source);
  fs.rmSync(gmkOut, { force: true });

  const out = { ...record, ...injected, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(buildDir, BUILD_RECORD), JSON.stringify(out, null, 2));
  return out;
}

module.exports = { build, readRecord, buildDirOf, GAME_IMAGE, BUILD_RECORD };
