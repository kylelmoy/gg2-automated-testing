#!/usr/bin/env node
//=============================================================================
// repro.js - run a repro script against one or more commits of the game.
//
// See README.md for the whole picture and docs/WRITING-REPROS.md for how to write one.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./lib/lib.js');
const { ensureBuilt, CACHE } = require('./lib/checkout.js');
const runner = require('./lib/runner.js');
const report = require('./lib/report.js');

const USAGE = `
usage: node repro.js <repro.js> [--ref <ref>]... [options]
       node repro.js <repro.js> --broken <ref> --fixed <ref> [options]
       node repro.js <repro.js> --repo <built checkout> [options]

  --ref <ref>       build this commit of the game and run the repro against it;
                    repeat for several (default: HEAD of --source)
  --broken <ref>    with --fixed: prove a fix. The bug must reproduce here...
  --fixed <ref>     ...and every run must pass here
  --repo <path>     run against a checkout that is already built, with no build
  --source <path>   the game repo refs are resolved in (default ../Gang-Garrison-2)
  --runs <n>        runs per ref (default 1); a timing-dependent bug may need more
  --out <dir>       where results and evidence go (default .cache/results/...)
  --rebuild         build even if a matching build is cached
  --port <n>        first bridge port (default 18777); clients take the next ones
  --hosting-port <n>  the game server's port (default 8290, so a playtest on
                    8190 is not disturbed)

Exit code: 0 when the question was answered as hoped - a fix proven, or with
--ref, every ref reproduced; 1 when it was not; 2 when the run itself failed.
`;

async function main() {
  const { flags, positional } = lib.parseArgs(process.argv.slice(2), [
    'ref', 'broken', 'fixed', 'repo', 'source', 'runs', 'out', 'port', 'hosting-port',
  ]);
  // parseArgs keeps the last of a repeated flag; --ref may be repeated.
  const refs = [];
  process.argv.slice(2).forEach((a, i, all) => {
    if (a === '--ref') refs.push(all[i + 1]);
  });
  if (flags.help || positional.length !== 1) lib.helpAndExit(USAGE);

  const repro = runner.load(positional[0]);
  const source = path.resolve(flags.source || path.join(__dirname, '..', 'Gang-Garrison-2'));
  const runs = Math.max(1, Number(flags.runs || 1));
  const prove = flags.broken || flags.fixed;
  if (prove && !(flags.broken && flags.fixed)) throw new Error('--broken and --fixed go together');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(flags.out || path.join(CACHE, 'results', `${path.basename(repro.file, '.js')}-${stamp}`));
  fs.mkdirSync(outDir, { recursive: true });

  lib.step(`${repro.title}${repro.issue ? ` (#${repro.issue})` : ''}`);

  // What to run against: [{ label, repo }]
  const targets = [];
  if (flags.repo) {
    targets.push({ label: path.basename(path.resolve(flags.repo)), repo: path.resolve(flags.repo) });
  } else {
    const wanted = prove ? [flags.broken, flags.fixed] : refs.length ? refs : ['HEAD'];
    for (const ref of wanted) {
      const built = await ensureBuilt({ source, ref, hooks: repro.hooks, rebuild: !!flags.rebuild });
      targets.push({ label: ref, repo: built.repo });
    }
  }

  const results = [];
  for (const target of targets) {
    lib.step(`Running against ${target.label}`);
    const r = await runner.runAll({
      repro,
      repo: target.repo,
      runs,
      outDir: path.join(outDir, target.label.replace(/[^A-Za-z0-9._-]/g, '_')),
      basePort: Number(flags.port || 18777),
      hostingPort: Number(flags['hosting-port'] || 8290),
    });
    r.ref = target.label;
    results.push(r);
    lib.ok(`${target.label}: ${report.refVerdict(r)}`);
  }

  const proofResult = prove ? report.proof(results[0], results[1]) : null;
  const md = report.markdown({ repro, results, proofResult });
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
  fs.writeFileSync(
    path.join(outDir, 'result.json'),
    JSON.stringify({ repro: { file: repro.file, title: repro.title, issue: repro.issue }, proof: proofResult, results }, null, 2)
  );

  process.stdout.write('\n' + md + '\n\n');
  lib.detail(`results and evidence: ${outDir}`);

  if (proofResult) {
    (proofResult.proven ? lib.ok : lib.fail)(proofResult.proven ? 'fix proven' : `fix not proven: ${proofResult.why}`);
    return proofResult.proven ? 0 : 1;
  }
  return results.every((r) => r.reproduced > 0) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    lib.fail(e.message);
    process.exit(2);
  }
);
