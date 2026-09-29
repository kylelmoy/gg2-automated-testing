#!/usr/bin/env node
//=============================================================================
// issue.js - take the repro script out of a GitHub issue or pull request.
//
//   node issue.js Gang-Garrison-2/Gang-Garrison-2#65
//   node repro.js "$(node issue.js owner/repo#65)" --ref master
//
// See lib/issue.js for which block is taken, and docs/WORKFLOW.md for why.
//=============================================================================

const fs = require('fs');
const path = require('path');
const lib = require('./lib/lib.js');
const { CACHE } = require('./lib/checkout.js');
const { parseTarget, findRepro } = require('./lib/issue.js');

const USAGE = `
usage: node issue.js <owner/repo#N | issue URL> [options]

Writes the thread's most recent \`\`\`js repro block to a file and prints its path.

  --out <file>      where to write it (default .cache/issues/<owner>-<repo>-<N>.js)
  --as-of <time>    ignore posts made after this ISO time, and refuse a block
                    edited after it: the time a maintainer asked for the run
  --json            print where the script came from as JSON, not just the path

Needs a GitHub token: GITHUB_TOKEN or GH_TOKEN, or a logged-in gh.
Exit code: 0 with a script written, 2 when there is none to take.
`;

async function main() {
  const { flags, positional } = lib.parseArgs(process.argv.slice(2), ['out', 'as-of']);
  if (flags.help || positional.length !== 1) lib.helpAndExit(USAGE);

  const target = parseTarget(positional[0]);
  const found = await findRepro(target, { asOf: flags['as-of'] });
  const out = path.resolve(flags.out || path.join(CACHE, 'issues', `${target.owner}-${target.repo}-${target.number}.js`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, found.code);

  if (flags.json) {
    const { code, ...source } = found;
    process.stdout.write(JSON.stringify({ file: out, issue: `${target.owner}/${target.repo}#${target.number}`, ...source }, null, 2) + '\n');
  } else {
    process.stdout.write(out + '\n');
  }
}

main().catch((e) => {
  process.stderr.write(`issue.js: ${e.message}\n`);
  process.exit(2);
});
