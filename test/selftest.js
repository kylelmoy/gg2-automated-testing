#!/usr/bin/env node
//=============================================================================
// selftest.js - check the tooling itself, with no game running.
//
//   node test/selftest.js [--source <game repo>]
//
// The last section injects into a cached worktree of the game repo (default
// ../Gang-Garrison-2) and resets it; it is skipped if there is no such repo.
// Nothing here launches Game Maker or the game - repro.js is the live test.
//=============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const lib = require('../lib/lib.js');
const spec = require('../lib/payload.js');
const { placeHook, opensBody, inject } = require('../lib/inject.js');
const { dialogsIn } = require('../lib/runner.js');
const report = require('../lib/report.js');
const { withIniValue } = require('../lib/session.js');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed++;
  else failures.push(`${name}${detail !== undefined ? `\n      ${detail}` : ''}`);
}
const section = (name) => process.stdout.write(`\n${name}\n`);

//---------------------------------------------------------------------------
section('hook placement');

check('an if with no brace opens a body', opensBody('    if (x == 1)'));
check('else opens a body', opensBody('else'));
check('a one-line if does not', !opensBody('if (x) y = 1;'));
check('an if with a brace does not', !opensBody('if (x) {'));
check('a case label does not', !opensBody('case BUILD_SENTRY:'));

{
  const code = ['a = 1;', 'if (b)', '    c = 2;', 'd = 3;'].join('\r\n');
  const after = placeHook(code, 'a = 1;', 'agentHook("h");', 'after');
  check('after a plain statement', after.text === ['a = 1;', 'agentHook("h");', 'if (b)', '    c = 2;', 'd = 3;'].join('\r\n'), after.text || after.error);
  check('refuses after a braceless if', /braceless body/.test(placeHook(code, 'if (b)', 'x;', 'after').error));
  check('refuses before the body of a braceless if', /braceless body/.test(placeHook(code, 'c = 2;', 'x;', 'before').error));
  const indented = placeHook(code, 'c = 2;', 'agentHook("h");', 'after');
  check('keeps the anchor indentation', indented.text && indented.text.includes('    c = 2;\r\n    agentHook("h");'), indented.text);
  check('missing anchor', placeHook(code, 'nope;', 'x;', 'after').error === 'anchor not found');
  check('ambiguous anchor', /2 times/.test(placeHook('a;\na;', 'a;', 'x;', 'after').error));
}

//---------------------------------------------------------------------------
section('payload');

{
  const dir = path.join(__dirname, '..', 'payload', 'Scripts', spec.SCRIPT_GROUP);
  const list = lib.readText(path.join(dir, '_resources.list.xml'));
  const registered = [...list.matchAll(/<resource name="([^"]+)"/g)].map((m) => m[1]);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.gml')).map((f) => f.replace(/\.gml$/, ''));
  for (const f of files) check(`${f}.gml is registered`, registered.includes(f));
  for (const r of registered) check(`${r} has a file`, files.includes(r));

  const called = new Set([...spec.CODE_PATCHES.map((p) => p.to), spec.hookLine('x')].flatMap((t) => t.match(/\bagent[A-Za-z0-9_]*(?=\()/g) || []));
  for (const fn of called) check(`${fn}, called from a patched line, is a payload script`, registered.includes(fn));
  for (const p of spec.CODE_PATCHES) check(`${p.file.join('/')} belongs to a known probe`, p.probe in spec.PROBES);

  // gmksplit writes the tree out as windows-1252 and replaces what it cannot.
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, `${f}.gml`), 'utf8');
    check(`${f}.gml is plain ASCII`, !/[^\x00-\x7f]/.test(text));
  }
}

//---------------------------------------------------------------------------
section('launcher log parsing');

{
  const file = path.join(os.tmpdir(), `gg2-test-launcher-${process.pid}.log`);
  fs.writeFileSync(
    file,
    [
      '20260923211330 launching Gang Garrison 2.exe -agent as client1',
      '20260923211331   E| ___________________________________________',
      '20260923211331   E| ERROR in',
      '20260923211331   E| Unknown variable foo',
      '20260923211331 dismissed Gang Garrison 2 (pressed Ignore) - 1 so far',
      '20260923211332   M| Assertion failed',
      '20260923211332 dismissed Message - 2 so far',
      '20260923211333   E| FATAL ERROR in',
      '20260923211333   M!| forced closed (no TBitBtn child to click)',
      '',
    ].join('\n')
  );
  const d = dialogsIn(file);
  check('three dialogs', d.length === 3, JSON.stringify(d));
  check('an error is marked E', d[0] && d[0].mark === 'E' && /Unknown variable foo/.test(d[0].text));
  check('a message is marked M', d[1] && d[1].mark === 'M');
  check('a force-closed error stays one dialog', d[2] && d[2].mark === 'E' && /forced closed/.test(d[2].text));
  fs.rmSync(file);
}

//---------------------------------------------------------------------------
section('verdicts');

{
  const ref = (name, verdicts) => ({
    ref: name,
    runs: verdicts.map((v) => ({ verdict: v })),
    reproduced: verdicts.filter((v) => v === 'REPRODUCED').length,
    passed: verdicts.filter((v) => v === 'PASS').length,
    inconclusive: verdicts.filter((v) => v === 'INCONCLUSIVE').length,
  });
  check('proven', report.proof(ref('a', ['REPRODUCED', 'PASS']), ref('b', ['PASS', 'PASS'])).proven);
  check('not proven if it never reproduced', !report.proof(ref('a', ['PASS']), ref('b', ['PASS'])).proven);
  check('not proven if the fix still reproduces', !report.proof(ref('a', ['REPRODUCED']), ref('b', ['PASS', 'REPRODUCED'])).proven);
  check('an inconclusive run on the fix is not a pass', !report.proof(ref('a', ['REPRODUCED']), ref('b', ['PASS', 'INCONCLUSIVE'])).proven);
}

//---------------------------------------------------------------------------
section('gg2.ini');

check('adds a section', withIniValue('', 'Settings', 'UseLobby', 0) === '[Settings]\nUseLobby=0');
check('replaces in place', withIniValue('[Settings]\r\nUseLobby=1\r\nX=2', 'Settings', 'UseLobby', 0) === '[Settings]\r\nUseLobby=0\r\nX=2');
check('no change is null', withIniValue('[Settings]\nUseLobby=0', 'Settings', 'UseLobby', 0) === null);

//---------------------------------------------------------------------------
section('inject into a real tree');

{
  const { flags } = lib.parseArgs(process.argv.slice(2), ['source']);
  const source = path.resolve(flags.source || path.join(__dirname, '..', '..', 'Gang-Garrison-2'));
  if (!fs.existsSync(path.join(source, 'Source', 'gg2'))) {
    process.stdout.write(`  skipped: no game repo at ${source}\n`);
  } else {
    const { resolveRef, worktree } = require('../lib/checkout.js');
    const sha = resolveRef(source, 'HEAD');
    const dir = worktree(source, sha);
    const r = inject(dir, {
      quiet: true,
      hooks: {
        good: { file: 'Scripts/Game/game_init.gml', after: spec.INIT_ANCHOR },
        missing: { file: 'Scripts/Game/game_init.gml', after: 'no such line;' },
      },
    });
    check('the bridge is created at startup', lib.readText(path.join(dir, 'Source', 'gg2', 'Scripts', 'Game', 'game_init.gml')).includes(spec.INIT_LINE.trim()));
    check('every probe is reported', Object.keys(spec.PROBES).every((p) => typeof r.probes[p] === 'boolean'), JSON.stringify(r.probes));
    check('the desync probe lands', r.probes.desync, JSON.stringify(r.patches.filter((p) => p.probe === 'desync')));
    check('a good hook lands', r.hooks.good.landed);
    check('a bad hook is reported, not thrown', r.hooks.missing.landed === false && r.hooks.missing.error === 'anchor not found');
    worktree(source, sha);
    const status = spawnSync('git', ['status', '--porcelain', '--', 'Source/gg2'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    check('a reset leaves the tree clean', status === '', status);
  }
}

//---------------------------------------------------------------------------

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
for (const f of failures) process.stdout.write(`  FAIL ${f}\n`);
process.exit(failures.length ? 1 : 0);
