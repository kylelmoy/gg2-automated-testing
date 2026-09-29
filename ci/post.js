#!/usr/bin/env node
//=============================================================================
// post.js - the post job of repro.yml: say what a run found, in the thread.
//
//   node ci/post.js <run dir>
//
// KIND says what the run was for:
//   confirm   an issue's repro against a branch. Always posted; an issue
//             that reproduces gets the repro-confirmed label, which puts it
//             in the nightly sweep.
//   prove     a pull request's proof. Always posted.
//   nightly   the sweep (sweep.js). An open issue should still reproduce and
//             a closed one should pass. Posted only when the outcome is not
//             the expected one and differs from what the last nightly
//             comment said, or when it is back to expected after one.
//
// Environment: KIND, REPO, THREAD, REPRO_BOT_TOKEN (optional: without it the
// comment only goes to the job summary), GITHUB_STEP_SUMMARY.
//=============================================================================

const fs = require('fs');
const { compose, outcome, markersIn } = require('./comment.js');
const { api, all, env } = require('./github.js');

const LABEL = 'repro-confirmed';

// What the nightly sweep says, if anything, given the issue's state, the
// outcome, and the outcome the last nightly comment reported (null if none).
// Pure, for the selftest.
function nightlyLead({ state, outcome: got, last }) {
  const expected = state === 'closed' ? 'PASS' : 'REPRODUCED';
  const lastUnexpected = last !== null && last !== expected;
  if (got === expected) {
    return lastUnexpected ? `**Nightly: back to expected.** This ${state} issue's repro gives ${got} again on the default branch.` : null;
  }
  if (got === last) return null; // already said
  if (state === 'closed' && got === 'REPRODUCED') {
    return '**Nightly: regression.** This issue is closed, but its repro reproduces again on the default branch.';
  }
  if (state === 'open' && got === 'PASS') {
    return '**Nightly: passes now.** This issue is open, but its repro no longer reproduces on the default branch. Fixed by something else?';
  }
  return `**Nightly: no answer (${got}).** The repro no longer runs to a verdict here; it may need updating, or asking for again with \`/repro\`.`;
}

async function main() {
  const dir = process.argv[2];
  const kind = env('KIND');
  const repo = env('REPO');
  const thread = Number(env('THREAD'));
  const token = process.env.REPRO_BOT_TOKEN;
  const got = outcome(dir);
  const summary = (text) => process.env.GITHUB_STEP_SUMMARY && fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');

  let lead = '';
  if (kind === 'nightly') {
    if (!token) throw new Error('the nightly sweep needs REPRO_BOT_TOKEN, to read the thread');
    const me = (await api(token, 'GET', '/user')).login;
    const { state } = await api(token, 'GET', `/repos/${repo}/issues/${thread}`);
    const comments = await all(token, `/repos/${repo}/issues/${thread}/comments`);
    const nightly = comments
      .filter((c) => c.user && c.user.login === me)
      .flatMap((c) => markersIn(c.body))
      .filter((m) => m.kind === 'nightly');
    const last = nightly.length ? nightly[nightly.length - 1].outcome : null;
    lead = nightlyLead({ state, outcome: got, last });
    summary(`#${thread} (${state}): ${got}; last nightly comment said ${last || 'nothing'}; ${lead ? 'commenting' : 'nothing to say'}\n`);
    if (!lead) return;
  }

  const body = compose(dir, { kind, lead });
  summary(body);
  if (!token) {
    console.log('::warning::No REPRO_BOT_TOKEN secret, so the report is only in this run\'s summary.');
    return;
  }
  await api(token, 'POST', `/repos/${repo}/issues/${thread}/comments`, { body });
  if (kind === 'confirm' && got === 'REPRODUCED') {
    await api(token, 'POST', `/repos/${repo}/issues/${thread}/labels`, { labels: [LABEL] });
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`post.js: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { nightlyLead, LABEL };
