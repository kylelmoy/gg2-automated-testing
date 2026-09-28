//=============================================================================
// checkout.js - a built game for any commit, without touching anyone's checkout.
//
// A repro is only worth something if it can be run against the commit before a
// fix and the commit after it, so the runner needs a game built from an
// arbitrary ref. Doing that in the developer's own checkout would mean
// switching their branch and injecting remote code execution into a tree they
// might commit from, so it happens here instead:
//
//   .cache/<source>/src           a --shared clone of the source repo. It
//                                 borrows the source's object store, so it is
//                                 small and sees every commit the source has.
//   .cache/<source>/trees/<sha>   one detached worktree per commit, with its
//                                 build in Source/build beside it.
//
// The source repo is only ever read. A worktree is reset with git before every
// build, so nothing injected into it survives to the next one.
//
// A build is reused when its record says it was made from the same commit,
// the same hooks and the same payload. Anything else rebuilds (~1 min).
//=============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const lib = require('./lib.js');
const { build, readRecord, buildDirOf, GAME_IMAGE } = require('./build.js');
const gm8builder = require('./gm8builder.js');

const ROOT = path.resolve(__dirname, '..');
const CACHE = process.env.GG2_TEST_CACHE || path.join(ROOT, '.cache');

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

// Everything that changes what an injected build contains. A change to any of
// these files, or to the gm8-builder version, invalidates every cached build.
function payloadHash() {
  const h = crypto.createHash('sha256');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(path.join(ROOT, 'payload'));
  files.push(path.join(ROOT, 'lib', 'payload.js'), path.join(ROOT, 'lib', 'inject.js'));
  for (const f of files.sort()) h.update(path.relative(ROOT, f)).update(fs.readFileSync(f));
  h.update(`gm8-builder ${gm8builder.VERSION}`);
  return h.digest('hex').slice(0, 16);
}

// JSON with sorted keys at every level, so the same hooks always hash the same.
const stable = (v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
    : JSON.stringify(v);

const hooksKey = (hooks) => crypto.createHash('sha256').update(stable(hooks || {})).digest('hex').slice(0, 16);

// A full sha for `ref`, as the source repo understands it - a branch, a tag,
// a remote branch or a sha.
function resolveRef(source, ref) {
  const sha = git(source, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  if (!sha) throw new Error(`${ref} is not a commit in ${source}`);
  return sha;
}

function srcClone(source) {
  const dir = path.join(CACHE, path.basename(path.resolve(source)), 'src');
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    lib.step(`Making a shared clone of ${source}`);
    git(CACHE, ['clone', '--shared', '--no-checkout', '--quiet', path.resolve(source), dir]);
  }
  return dir;
}

// The worktree for `sha`, checked out clean.
function worktree(source, sha) {
  const src = srcClone(source);
  const dir = path.join(path.dirname(src), 'trees', sha.slice(0, 12));
  if (!fs.existsSync(path.join(dir, '.git'))) {
    // A worktree whose directory was deleted by hand is still registered.
    git(src, ['worktree', 'prune']);
    lib.step(`Checking out ${sha.slice(0, 12)}`);
    git(src, ['worktree', 'add', '--detach', '--force', dir, sha]);
  } else {
    git(dir, ['checkout', '--force', '--quiet', '--detach', sha]);
    git(dir, ['clean', '-fdq', '--', 'Source/gg2']);
  }
  return dir;
}

// A built game for `ref`: { repo, sha, record, reused }.
async function ensureBuilt({ source, ref, hooks = {}, rebuild = false, quiet = false }) {
  const sha = resolveRef(source, ref);
  const key = { sha, hooks: hooksKey(hooks), payload: payloadHash() };
  const src = srcClone(source);
  const dir = path.join(path.dirname(src), 'trees', sha.slice(0, 12));

  const have = fs.existsSync(dir) ? readRecord(dir) : null;
  if (
    !rebuild && have && have.key &&
    have.key.sha === key.sha && have.key.hooks === key.hooks && have.key.payload === key.payload &&
    fs.existsSync(path.join(buildDirOf(dir), GAME_IMAGE))
  ) {
    lib.skip(`${ref} (${sha.slice(0, 12)}) is already built`, quiet);
    return { repo: dir, sha, record: have, reused: true };
  }

  const repo = worktree(source, sha);
  const subject = git(repo, ['log', '-1', '--format=%s']);
  lib.step(`Building ${ref} (${sha.slice(0, 12)} ${subject})`, quiet);
  const record = await build({ repo, hooks, quiet, record: { key, ref, subject } });
  return { repo, sha, record, reused: false };
}

module.exports = { ensureBuilt, resolveRef, worktree, CACHE };
