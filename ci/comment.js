#!/usr/bin/env node
//=============================================================================
// comment.js - the comment a CI run posts back to the issue or pull request.
//
//   node ci/comment.js <run dir> > comment.md
//
// <run dir> is what the run job uploaded: source.json from issue.js, meta.json
// from the workflow, and results/ from repro.js. Everything in it was written
// while a repro - arbitrary code - was running, so this only reads it, as
// text, and the posting job never executes any of it.
//=============================================================================

const fs = require('fs');
const path = require('path');

// GitHub refuses comments over 65536 characters.
const LIMIT = 60000;

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

function compose(dir) {
  const meta = readJson(path.join(dir, 'meta.json')) || {};
  const source = readJson(path.join(dir, 'source.json'));
  const report = readText(path.join(dir, 'results', 'report.md'));
  const run = meta.runUrl ? `[the run](${meta.runUrl})` : 'the run';
  const lines = [];

  if (source) {
    lines.push(
      `Ran the repro from [#${source.from}](${source.url}) by ${source.author || 'unknown'}, ` +
        `sha256 \`${String(source.sha256).slice(0, 12)}\`, as of ${meta.asOf || source.postedAt}. Logs are in ${run}.`
    );
  } else {
    lines.push(`Could not take a repro out of the thread: ${meta.extractError || 'see the log'}. Details are in ${run}.`);
  }
  if (meta.note) lines.push('', meta.note);

  if (source && report) {
    lines.push('', report.trim());
  } else if (source) {
    // repro.js exits 2 when the tool itself failed, before any verdict.
    lines.push('', `The run failed before it reached a verdict (exit code ${meta.exitCode === undefined ? '?' : meta.exitCode}). Details are in ${run}.`);
  }

  let text = lines.join('\n') + '\n';
  if (text.length > LIMIT) text = text.slice(0, LIMIT) + `\n\n(truncated; the full report is in ${run})\n`;
  return text;
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    process.stderr.write('usage: node ci/comment.js <run dir>\n');
    process.exit(2);
  }
  process.stdout.write(compose(process.argv[2]));
}

module.exports = { compose };
