//=============================================================================
// lib.js - shared helpers.
//
// stopGamesIn stops games by where their exe lives, not by image name: the
// runner builds and runs in its own directories, and a game someone has open
// elsewhere on the machine is none of its business.
//
// File edits are byte-preserving: the game tree mixes LF and CRLF, and
// GmkSplitter parses much of it as XML, where a flipped line ending or a stray
// BOM is noise at best.
//=============================================================================

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

//---------------------------------------------------------------------------
// Output
//---------------------------------------------------------------------------

const COLOUR = { cyan: '\x1b[36m', green: '\x1b[32m', grey: '\x1b[90m', yellow: '\x1b[33m', red: '\x1b[31m', off: '\x1b[0m' };
const colour = process.stdout.isTTY;
const sink = (line) => process.stdout.write(line + '\n');

function tag(mark, c, msg) {
  sink(colour ? `${c}[${mark}]${COLOUR.off} ${msg}` : `[${mark}] ${msg}`);
}

const step = (m, quiet) => { if (!quiet) tag('*', COLOUR.cyan, m); };
const ok = (m, quiet) => { if (!quiet) tag('+', COLOUR.green, m); };
const skip = (m, quiet) => { if (!quiet) tag('=', COLOUR.grey, m); };
const warn = (m) => tag('-', COLOUR.yellow, m);
const fail = (m) => tag('!', COLOUR.red, m);
const detail = (m) => sink('      ' + m);

//---------------------------------------------------------------------------
// Arguments: --name or --name value; anything else is positional.
//---------------------------------------------------------------------------

function parseArgs(argv, valueFlags = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (valueFlags.includes(name)) flags[name] = argv[++i];
    else flags[name] = true;
  }
  return { flags, positional };
}

function helpAndExit(usage) {
  process.stdout.write(usage.trim() + '\n');
  process.exit(0);
}

function resolveGg2Tree(repo) {
  if (!fs.existsSync(repo)) throw new Error(`repo not found: ${repo}`);
  const tree = path.join(path.resolve(repo), 'Source', 'gg2');
  if (!fs.existsSync(path.join(tree, 'Objects', '_resources.list.xml'))) {
    throw new Error(`does not look like a Gang Garrison 2 checkout: ${path.resolve(repo)}`);
  }
  return tree;
}

//---------------------------------------------------------------------------
// Byte-preserving text edits
//
// latin1 maps every byte to one character and back, so a file read and written
// this way is unchanged except where it was edited, whatever its encoding.
//---------------------------------------------------------------------------

const readText = (p) => fs.readFileSync(p, 'latin1');
const writeText = (p, text) => fs.writeFileSync(p, Buffer.from(text, 'latin1'));
const newlineOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

// Insert `insert` next to the first line whose trimmed text equals `anchor`.
// Returns null if `insert` is already present; throws if `anchor` is not found.
function insertLineText(text, anchor, insert, where) {
  if (text.includes(insert.trim())) return null;
  const lines = text.split(/\r?\n/);
  const result = [];
  let done = false;
  for (const line of lines) {
    if (where === 'after') result.push(line);
    if (!done && line.trim() === anchor) {
      result.push(insert);
      done = true;
    }
    if (where === 'before') result.push(line);
  }
  if (!done) throw new Error(`anchor '${anchor}' not found`);
  return result.join(newlineOf(text));
}

function insertLine(file, anchor, insert, where) {
  const next = insertLineText(readText(file), anchor, insert, where);
  if (next === null) return false;
  writeText(file, next);
  return true;
}

const addBeforeLine = (file, anchor, insert) => insertLine(file, anchor, insert, 'before');
const addAfterLine = (file, anchor, insert) => insertLine(file, anchor, insert, 'after');

// Replace the first line whose trimmed text equals `from` with `to`, keeping
// its indentation. Returns null if `to` is already there; throws if `from` is
// not found. Swapping a whole line, rather than inserting one beside it, is
// what keeps the braceless body of an `if` inside its `if`.
function replaceLineText(text, from, to) {
  const lines = text.split(/\r?\n/);
  if (lines.some((l) => l.trim() === to.trim())) return null;
  let done = false;
  const out = lines.map((line) => {
    if (done || line.trim() !== from.trim()) return line;
    done = true;
    return line.slice(0, line.length - line.trimStart().length) + to.trim();
  });
  if (!done) throw new Error(`line '${from}' not found`);
  return out.join(newlineOf(text));
}

//---------------------------------------------------------------------------
// Processes
//---------------------------------------------------------------------------

// Run a program, forwarding its output line by line; throw on a non-zero exit.
function run(exe, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    let buf = '';
    const onData = (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim()) detail(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => reject(new Error(`could not run ${exe}: ${e.message}`)));
    child.on('close', (code) => {
      if (buf.trim()) detail(buf.trim());
      if (code !== 0) reject(new Error(`${path.basename(exe)} exited with code ${code}`));
      else resolve();
    });
  });
}

// Run a program and return its stdout, ignoring a non-zero exit code.
function capture(exe, args, cwd) {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRunning(imageName) {
  const out = capture('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/NH', '/FO', 'CSV']);
  return out.toLowerCase().includes(imageName.toLowerCase());
}

// CLI entry point: report a failure and exit 1.
function cli(main) {
  main().catch((e) => {
    fail(e.message);
    process.exit(1);
  });
}

// The pids of every running copy of `imageName` whose executable is inside
// `dir`. Asked of WMI because tasklist cannot report a process's path.
function gamesIn(dir, imageName) {
  const root = path.resolve(dir).toLowerCase() + path.sep;
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${imageName}'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`;
  return capture('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps])
    .split(/\r?\n/)
    .map((l) => l.split('|'))
    .filter(([pid, exe]) => pid && exe && path.resolve(exe).toLowerCase().startsWith(root))
    .map(([pid]) => Number(pid));
}

// Stop every copy of `imageName` running from inside `dir`, and nothing else.
async function stopGamesIn(dir, imageName, timeoutMs = 5000) {
  const pids = gamesIn(dir, imageName);
  if (pids.length === 0) return false;
  for (const pid of pids) spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gamesIn(dir, imageName).length === 0) return true;
    await sleep(250);
  }
  throw new Error(`${imageName} is still running from ${dir} - close it and try again`);
}

// Launch a program and detach from it, the way the game and its launcher need.
function launchDetached(exe, args, cwd) {
  const child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

function connectOnce(port, host) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (result) => {
      s.removeAllListeners();
      s.destroy();
      resolve(result);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// Note that a successful probe is itself a connection the game accepts and
// then sees drop - harmless, and why each bridge log starts with a
// connect/disconnect pair.
async function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await connectOnce(port, host)) return true;
  }
  return false;
}

module.exports = {
  step, ok, skip, warn, fail, detail,
  parseArgs, helpAndExit, cli, resolveGg2Tree,
  readText, writeText, insertLineText, addBeforeLine, addAfterLine, replaceLineText,
  run, capture, sleep, isRunning, gamesIn, stopGamesIn, launchDetached, waitForPort,
};
