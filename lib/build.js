//=============================================================================
// build.js - build a game tree, with the bridge injected, into an executable.
//
// Unattended, start to finish:
//
//   1. inject        the bridge, the probes and a repro's hooks
//   2. gm8-builder   pack Source/gg2 into the executable, with gm8x_fix's
//                    patches (gm8builder.js)
//   3. record        what landed, in agent_build.json beside the exe
//
// There is no cleanup step: this only ever runs on a worktree checkout.js
// owns, which it resets with git before the next build.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');
const { inject } = require('./inject.js');
const gm8builder = require('./gm8builder.js');

const GAME_IMAGE = 'Gang Garrison 2.exe';
const BUILD_RECORD = 'agent_build.json';

const buildDirOf = (repo) => path.join(path.resolve(repo), 'Source', 'build');

const readRecord = (repo) => {
  const file = path.join(buildDirOf(repo), BUILD_RECORD);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};

async function build({ repo, hooks = {}, record = {}, quiet = false }) {
  const repoFull = path.resolve(repo);
  const buildDir = buildDirOf(repoFull);
  const exeOut = path.join(buildDir, GAME_IMAGE);

  const injected = inject(repoFull, { hooks, quiet });

  // Only games running from this directory hold it; nothing else is touched.
  await lib.stopGamesIn(buildDir, GAME_IMAGE);
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  lib.step('Building', quiet);
  const started = Date.now();
  await gm8builder.buildExe({ tree: path.join(repoFull, 'Source', 'gg2'), exe: exeOut });
  lib.ok(`built in ${((Date.now() - started) / 1000).toFixed(0)}s (${fs.statSync(exeOut).size} bytes)`, quiet);

  const out = { ...record, ...injected, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(buildDir, BUILD_RECORD), JSON.stringify(out, null, 2));
  return out;
}

module.exports = { build, readRecord, buildDirOf, GAME_IMAGE, BUILD_RECORD };
