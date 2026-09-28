//=============================================================================
// gm8builder.js - find gm8-builder, and Game Maker 8's data files for it.
//
// gm8-builder (github.com/kylelmoy/gm8-builder) packs a GmkSplitter tree
// straight into an executable, with no Game Maker process. It is not part of
// this repo: the pinned release below is downloaded into .cache/tools on first
// use and checked against its sha256. Set GM8_BUILDER to use another build of
// it instead, such as one from source.
//
// The runner, its DLL and the action libraries come from a Game Maker 8.0
// install (GM8_DIR), or, with GM8_TEMPLATE set, from any earlier GM8 build of
// the game. A template lets a CI machine build with no Game Maker install on it.
// The extension packages come from the commit's own Extensions/*.gex: an
// install carries whatever versions were once installed into it (Faucet
// Networking 1.2.1 from 2011, on the machine this was written on, where the
// game ships 1.8).
//=============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const lib = require('./lib.js');

const VERSION = '0.2.0';
const WINDOWS = process.platform === 'win32';
const PLATFORM = WINDOWS ? 'win-x64' : 'linux-x64';
const ASSET = `gm8-builder-v${VERSION}-${PLATFORM}.zip`;
const URL = `https://github.com/kylelmoy/gm8-builder/releases/download/v${VERSION}/${ASSET}`;
const SHA256 = {
  'win-x64': 'c1e625b5d81be52fceab922b582097c0bee2979a1b996616ab556aac25e7e7ec',
  'linux-x64': 'f034f2eb07eb8c370bf6bf09c5c395c524ca7b256a7e6998fed5b3d8e97ae9fe',
}[PLATFORM];

const TOOLS = path.resolve(__dirname, '..', '.cache', 'tools');
const INSTALL = path.join(TOOLS, `gm8-builder-v${VERSION}`);
const EXE = path.join(INSTALL, `gm8-builder-${PLATFORM}`, WINDOWS ? 'gm8-builder.exe' : 'gm8-builder');

async function download() {
  lib.step(`Downloading gm8-builder v${VERSION}`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`could not download ${URL}: HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const digest = crypto.createHash('sha256').update(zip).digest('hex');
  if (digest !== SHA256) throw new Error(`${ASSET} has sha256 ${digest}, expected ${SHA256}`);

  // Unpacked beside the final directory and renamed into place, so a run
  // going on in parallel never sees half an install.
  fs.mkdirSync(TOOLS, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(TOOLS, 'download-'));
  try {
    fs.writeFileSync(path.join(tmp, ASSET), zip);
    // Windows' own tar.exe is bsdtar, which reads zips. Git's tar is not.
    const r = WINDOWS
      ? spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', ASSET], { cwd: tmp, encoding: 'utf8', windowsHide: true })
      : spawnSync('unzip', ['-q', ASSET], { cwd: tmp, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not unpack ${ASSET}: ${(r.stderr || r.error || '').toString().trim()}`);
    fs.rmSync(path.join(tmp, ASSET));
    try {
      fs.renameSync(tmp, INSTALL);
    } catch (e) {
      if (!fs.existsSync(EXE)) throw e; // someone else installed it first
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!fs.existsSync(EXE)) throw new Error(`${ASSET} did not contain ${path.relative(INSTALL, EXE)}`);
  if (!WINDOWS) fs.chmodSync(EXE, 0o755);
}

async function resolveBuilder() {
  const own = process.env.GM8_BUILDER;
  if (own) {
    if (!fs.existsSync(own)) throw new Error(`GM8_BUILDER is set to ${own}, which does not exist`);
    return own;
  }
  if (!fs.existsSync(EXE)) await download();
  return EXE;
}

// gm8-builder needs rundata, dxdata, lib/ and extensions/ from a Game Maker 8.0
// install, or a copy of just those.
function resolveGm8Dir() {
  if (!WINDOWS && !process.env.GM8_DIR) throw new Error('Game Maker 8 not found - set GM8_DIR or GM8_TEMPLATE (see README.md, "Setup")');
  const guesses = [
    process.env.GM8_DIR,
    'D:\\GameDev\\Game_Maker_8',
    'C:\\Program Files (x86)\\Game_Maker_8',
    'C:\\Program Files\\Game_Maker_8',
  ].filter(Boolean);
  const dir = guesses.find((g) => fs.existsSync(path.join(g, 'rundata')));
  if (!dir) throw new Error('Game Maker 8 not found - set GM8_DIR (see README.md, "Setup")');
  return dir;
}

// A GM8 build of the game to take the runner from instead of an install, or null.
function resolveTemplate() {
  const own = process.env.GM8_TEMPLATE;
  if (own && !fs.existsSync(own)) throw new Error(`GM8_TEMPLATE is set to ${own}, which does not exist`);
  return own || null;
}

// What, besides the tree, decides the bytes of a build: part of the cache key.
function runtimeKey() {
  const template = resolveTemplate();
  if (!template) return `gm8-builder ${VERSION}`;
  const digest = crypto.createHash('sha256').update(fs.readFileSync(template)).digest('hex');
  return `gm8-builder ${VERSION} template ${digest}`;
}

// Build a GmkSplitter tree into an executable, with gm8x_fix's runner patches.
// `extensions` is a directory of .gex files, or null to take the extensions
// from the install or template too.
async function buildExe({ tree, exe, extensions }) {
  const builder = await resolveBuilder();
  const template = resolveTemplate();
  const runtime = template ? ['--template', template] : ['--gm8', resolveGm8Dir()];
  if (extensions) runtime.push('--extensions', extensions);
  await lib.run(builder, ['build', tree, exe, ...runtime, '--gm8x-fix']);
  if (!fs.existsSync(exe)) throw new Error(`gm8-builder produced no ${exe}`);
  // Wine will not start an image without the execute bit (error 5).
  if (!WINDOWS) fs.chmodSync(exe, 0o755);
}

module.exports = { buildExe, resolveBuilder, runtimeKey, VERSION };
