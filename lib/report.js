//=============================================================================
// report.js - turn run results into a verdict and a Markdown summary.
//
// The Markdown is written to be pasted into an issue or a PR as it is.
//=============================================================================

const short = (sha) => (sha ? sha.slice(0, 12) : '?');

// What one ref's runs add up to.
function refVerdict(r) {
  const n = r.runs.length;
  if (r.reproduced > 0) return `REPRODUCED (${r.reproduced}/${n})`;
  if (r.inconclusive > 0) return `INCONCLUSIVE (${r.inconclusive}/${n})`;
  return `PASS (${r.passed}/${n})`;
}

// A fix is proven when the bug shows on the broken ref at least once, and the
// fixed ref passes every run - an inconclusive run on the fixed side means it
// was never asked, so it does not count as a pass.
function proof(broken, fixed) {
  if (broken.reproduced === 0) {
    return { proven: false, why: `the bug did not reproduce on ${broken.ref}, so there is nothing for the fix to fix` };
  }
  if (fixed.reproduced > 0) {
    return { proven: false, why: `the bug still reproduces on ${fixed.ref} (${fixed.reproduced}/${fixed.runs.length})` };
  }
  if (fixed.inconclusive > 0) {
    return { proven: false, why: `${fixed.inconclusive} run(s) on ${fixed.ref} were inconclusive` };
  }
  return {
    proven: true,
    why: `reproduced ${broken.reproduced}/${broken.runs.length} on ${broken.ref}, passed ${fixed.passed}/${fixed.runs.length} on ${fixed.ref}`,
  };
}

function refSection(r, label) {
  const lines = [];
  lines.push(`### ${label ? `${label}: ` : ''}\`${r.ref}\` (${short(r.sha)}) - ${refVerdict(r)}`);
  if (r.subject) lines.push('', `> ${r.subject}`);
  const probes = Object.entries(r.probes).map(([k, v]) => (v ? k : `~~${k}~~`)).join(', ');
  if (probes) lines.push('', `Probes: ${probes}`);
  lines.push('', '| run | verdict | reason | time |', '|---|---|---|---|');
  r.runs.forEach((run, i) => {
    const reason = run.reason.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 300);
    lines.push(`| ${i + 1} | ${run.verdict} | ${reason} | ${run.seconds}s |`);
  });
  const tripped = r.runs.flatMap((run) => run.tripped).slice(0, 10);
  if (tripped.length) {
    lines.push('', '<details><summary>Built-in checks that tripped</summary>', '', '```');
    for (const x of tripped) lines.push(`${x.check} ${x.game}: ${x.text}`);
    lines.push('```', '', '</details>');
  }
  return lines.join('\n');
}

function markdown({ repro, results, proofResult }) {
  const lines = [];
  lines.push(`## Repro: ${repro.title}${repro.issue ? ` (#${repro.issue})` : ''}`);
  lines.push('');
  if (proofResult) {
    lines.push(`**${proofResult.proven ? 'Fix proven' : 'Fix not proven'}**: ${proofResult.why}.`);
    lines.push('');
  }
  const labels = proofResult ? ['broken', 'fixed'] : [];
  results.forEach((r, i) => lines.push(refSection(r, labels[i]), ''));
  lines.push(`<sub>gg2-automated-testing, ${new Date().toISOString()}</sub>`);
  return lines.join('\n');
}

module.exports = { refVerdict, proof, markdown };
