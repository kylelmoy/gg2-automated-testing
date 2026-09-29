#!/usr/bin/env node
//=============================================================================
// comment.js - the comment a CI run posts back to the issue or pull request.
//
//   node ci/comment.js <run dir> > comment.md
//
// <run dir> is what the run job uploaded: source.json from issue.js and
// meta.json, both written on the runner's host, and results/, written by
// repro.js in the container while a repro - arbitrary code - was running.
// results/ is only ever read here, as text or data, and the posting job
// executes none of it.
//
// Every comment ends in a marker the nightly sweep reads back (sweep.js): the
// script's sha256 and the time it was taken as of, which pin a maintainer's
// approval to exactly that script, and the run's outcome.
//=============================================================================

const fs = require('fs');
const path = require('path');

// GitHub refuses comments over 65536 characters.
const LIMIT = 60000;
const MARKER = 'gg2-repro';

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
};

// What a run came to, in one word: REPRODUCED, PASS or INCONCLUSIVE for a
// run against refs, PROVEN or NOT PROVEN for a proof, FAILED when no verdict
// was reached at all.
function outcome(dir) {
  const result = readJson(path.join(dir, 'results', 'result.json'));
  if (!readJson(path.join(dir, 'source.json')) || !result || !Array.isArray(result.results) || !result.results.length) return 'FAILED';
  if (result.proof) return result.proof.proven ? 'PROVEN' : 'NOT PROVEN';
  const r = result.results[0];
  if (r.reproduced > 0) return 'REPRODUCED';
  if (r.inconclusive > 0) return 'INCONCLUSIVE';
  return 'PASS';
}

const marker = (data) => `<!-- ${MARKER} ${JSON.stringify(data).replace(/--/g, '-\\u002d')} -->`;

// Every marker in a comment body, oldest first.
function markersIn(body) {
  const found = [];
  for (const m of (body || '').matchAll(new RegExp(`<!-- ${MARKER} (\\{.*?\\}) -->`, 'g'))) {
    try {
      found.push(JSON.parse(m[1]));
    } catch (e) {
      /* not ours, or damaged */
    }
  }
  return found;
}

// `lead` goes above the report: the nightly sweep's say on what changed.
function compose(dir, { kind = 'confirm', lead = '' } = {}) {
  const meta = readJson(path.join(dir, 'meta.json')) || {};
  const source = readJson(path.join(dir, 'source.json'));
  const report = readText(path.join(dir, 'results', 'report.md'));
  const run = meta.runUrl ? `[the run](${meta.runUrl})` : 'the run';
  const lines = [];

  if (lead) lines.push(lead, '');
  if (source) {
    lines.push(
      `Ran the repro from [#${source.from}](${source.url}) by ${source.author || 'unknown'}, ` +
        `sha256 \`${String(source.sha256).slice(0, 12)}\`, as of ${meta.asOf || source.postedAt}. Logs are in ${run}.`
    );
  } else {
    lines.push(`Could not take a repro out of the thread: ${meta.extractError || 'see the log'}. Details are in ${run}.`);
  }

  if (source && report) {
    lines.push('', report.trim());
  } else if (source) {
    // repro.js exits 2 when the tool itself failed, before any verdict.
    lines.push('', `The run failed before it reached a verdict (exit code ${meta.exitCode === undefined ? '?' : meta.exitCode}). Details are in ${run}.`);
  }

  const tail =
    '\n' +
    marker({
      kind,
      source: source ? source.from : null,
      sha256: source ? source.sha256 : null,
      asOf: meta.asOf || null,
      outcome: outcome(dir),
    }) +
    '\n';
  let text = lines.join('\n') + '\n';
  if (text.length + tail.length > LIMIT) text = text.slice(0, LIMIT - tail.length - 200) + `\n\n(truncated; the full report is in ${run})\n`;
  return text + tail;
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    process.stderr.write('usage: node ci/comment.js <run dir>\n');
    process.exit(2);
  }
  process.stdout.write(compose(process.argv[2]));
}

module.exports = { compose, outcome, markersIn };
