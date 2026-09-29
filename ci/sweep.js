#!/usr/bin/env node
//=============================================================================
// sweep.js - plan the nightly sweep: which issues to run, and which script.
//
// The sweep covers every issue labelled repro-confirmed. It must not run
// whatever a thread's latest ```js repro block happens to be tonight - anyone
// can post one - so it runs the script a maintainer last asked for: the bot's
// latest confirm report records that script's sha256 and the time it was
// taken as of (comment.js). The run takes the thread as of that time again,
// and refuses a script whose hash differs.
//
// Writes `matrix` (JSON, for repro-nightly.yml) and `count` to GITHUB_OUTPUT,
// and a line per issue to the job summary.
//
// Environment: TARGET_REPO, REPRO_BOT_TOKEN, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY.
//=============================================================================

const fs = require('fs');
const { markersIn } = require('./comment.js');
const { LABEL } = require('./post.js');
const { api, all, env } = require('./github.js');

// The approval to run for one issue - the latest confirm marker from the bot
// that says which script - or null. Pure, for the selftest.
function approval(comments, bot) {
  const confirms = comments
    .filter((c) => c.user && c.user.login === bot)
    .flatMap((c) => markersIn(c.body))
    .filter((m) => m.kind === 'confirm' && /^[0-9a-f]{64}$/.test(m.sha256 || '') && m.asOf);
  return confirms.length ? confirms[confirms.length - 1] : null;
}

async function main() {
  const target = env('TARGET_REPO');
  const token = env('REPRO_BOT_TOKEN');
  const me = (await api(token, 'GET', '/user')).login;
  const branch = (await api(token, 'GET', `/repos/${target}`)).default_branch;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error(`unexpected default branch name: ${branch}`);

  const issues = (await all(token, `/repos/${target}/issues?labels=${LABEL}&state=all`)).filter((i) => !i.pull_request);
  const matrix = [];
  const lines = [`Nightly sweep of ${target} on \`${branch}\`: ${issues.length} issue(s) labelled ${LABEL}.`, ''];
  for (const issue of issues) {
    const found = approval(await all(token, `/repos/${target}/issues/${issue.number}/comments`), me);
    if (!found) {
      lines.push(`- #${issue.number}: skipped, no confirm report from ${me} says which script was approved`);
      continue;
    }
    matrix.push({ issue: issue.number, as_of: found.asOf, sha256: found.sha256, branch });
    lines.push(`- #${issue.number} (${issue.state}): script ${found.sha256.slice(0, 12)} as of ${found.asOf}`);
  }

  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\ncount=${matrix.length}\n`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`sweep.js: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { approval };
