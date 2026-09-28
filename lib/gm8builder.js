//=============================================================================
// gm8builder.js - find gm8-builder, and Game Maker 8's data files for it.
//
// gm8-builder (github.com/kylelmoy/gm8-builder) packs a GmkSplitter tree
// straight into an executable, with no Game Maker process. It is not part of
// this repo: the pinned release below is downloaded into .cache/tools on first
// use and checked against its sha256. Set GM8_BUILDER to use another build of
// it instead, such as one from source.
//=============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const lib = require('./lib.js');

const VERSION = '0.1.0';
const ASSET = `gm8-builder-v${VERSION}-win-x64.zip`;
const URL = `https://github.com/kylelmoy/gm8-builder/releases/download/v${VERSION}/${ASSET}`;
const SHA256 = '501b977f6ee1b270c14c3d7a8d90dabfd721cf32da7ba761503d55bdb452e408';

const TOOLS = path.resolve(__dirname, '..', '.cache', 'tools');
const INSTALL = path.join(TOOLS, `gm8-builder-v${VERSION}`);
const EXE = path.join(INSTALL, 'gm8-builder-win-x64', 'gm8-builder.exe');

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
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const r = spawnSync(tar, ['-xf', ASSET], { cwd: tmp, encoding: 'utf8', windowsHide: true });
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

// Build a GmkSplitter tree into an executable, with gm8x_fix's runner patches.
async function buildExe({ tree, exe }) {
  const builder = await resolveBuilder();
  await lib.run(builder, ['build', tree, exe, '--gm8', resolveGm8Dir(), '--gm8x-fix']);
  if (!fs.existsSync(exe)) throw new Error(`gm8-builder produced no ${exe}`);
}

module.exports = { buildExe, VERSION };
