#!/usr/bin/env node
//=============================================================================
// poll.js - turn /repro comments in the game repo into workflow runs.
//
// Workflows in this repo cannot see events in the game repo, so repro-poll.yml
// runs this on a schedule. It reads the last two days of comments on issues
// and pull requests, and for each /repro from someone on the allow list that
// the bot has not answered yet, it starts "Confirm an issue" or "Prove a pull
// request" with the comment's own time as --as-of: what runs is the script as
// it stood when they asked.
//
// Answered means the bot has reacted: eyes when it started a run, confused
// when it could not make sense of the request. The reactions are the only
// state, and they tell the person who asked that the request was seen.
//
//   /repro                  run the thread's repro
//   /repro runs=5           ...five times (per side, for a pull request)
//   /repro ref=my-branch    on an issue: against that branch, not master
//
// Environment: TARGET_REPO (owner/name), REPRO_ALLOW (comma-separated logins;
// empty means nobody), REPRO_BOT_TOKEN (reads and reacts in TARGET_REPO),
// GITHUB_TOKEN and GITHUB_REPOSITORY (starts workflows in this repo),
// HARNESS_REF (the branch the workflows run from, default main).
//
// Comment bodies are text from anyone; this only matches them against the
// grammar above, and nothing in them reaches a shell.
//=============================================================================

const { api, all, env } = require('./github.js');

const LOOKBACK_MS = 2 * 24 * 3600 * 1000;
const MAX_RUNS = 10;

// Strip fenced code blocks, so a line in a pasted script is never a command.
const withoutCode = (body) => (body || '').replace(/^ {0,3}(([`~])\2{2,})[\s\S]*?^ {0,3}\1\2*[ \t]*$/gm, '');

// The /repro request in a comment: null if there is none, { error } if it
// cannot be followed, else { runs, ref }.
function parseRequest(body, { isPull }) {
  const line = withoutCode(body)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^\/repro(\s|$)/.test(l));
  if (!line) return null;
  const request = { runs: null, ref: null };
  for (const word of line.split(/\s+/).slice(1)) {
    let m;
    if ((m = /^runs=(\d+)$/.exec(word)) && Number(m[1]) >= 1 && Number(m[1]) <= MAX_RUNS) request.runs = Number(m[1]);
    else if (!isPull && (m = /^ref=([A-Za-z0-9._/-]+)$/.exec(word)) && !m[1].startsWith('-')) request.ref = m[1];
    else return { error: `not understood: ${word}` };
  }
  return request;
}

// Which comments to act on, and how. Pure, for the selftest.
function plan(comments, { allow, answered }) {
  const out = [];
  for (const c of comments) {
    if (answered.has(c.id)) continue;
    const login = c.user && c.user.login;
    if (!allow.includes(login)) continue;
    const isPull = /\/pull\/\d+#/.test(c.html_url || '');
    const request = parseRequest(c.body, { isPull });
    if (!request) continue;
    const number = Number(/\/(\d+)$/.exec(c.issue_url)[1]);
    out.push({ comment: c, number, isPull, request });
  }
  return out;
}

async function main() {
  const target = env('TARGET_REPO');
  const bot = env('REPRO_BOT_TOKEN');
  const harness = env('GITHUB_REPOSITORY');
  const dispatcher = env('GITHUB_TOKEN');
  const ref = process.env.HARNESS_REF || 'main';
  const allow = (process.env.REPRO_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.length) {
    console.log('REPRO_ALLOW is empty, so nobody can ask for a run.');
    return;
  }

  const me = (await api(bot, 'GET', '/user')).login;
  const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const comments = await all(bot, `/repos/${target}/issues/comments?since=${since}&sort=created&direction=asc`);

  // Only the candidates' reactions are worth fetching.
  const candidates = plan(comments, { allow, answered: new Set() });
  const answered = new Set();
  for (const { comment } of candidates) {
    const reactions = await api(bot, 'GET', `/repos/${target}/issues/comments/${comment.id}/reactions?per_page=100`);
    if (reactions.some((r) => r.user && r.user.login === me)) answered.add(comment.id);
  }

  const react = (comment, content) => api(bot, 'POST', `/repos/${target}/issues/comments/${comment.id}/reactions`, { content });
  for (const { comment, number, isPull, request } of plan(comments, { allow, answered })) {
    const where = `${target}#${number} (${comment.html_url})`;
    if (request.error) {
      console.log(`${where}: ${request.error}`);
      await react(comment, 'confused');
      continue;
    }
    const inputs = { repo: target, as_of: comment.created_at };
    if (request.runs) inputs.runs = String(request.runs);
    let workflow;
    if (isPull) {
      workflow = 'repro-pr.yml';
      inputs.pr = String(number);
    } else {
      workflow = 'repro-issue.yml';
      inputs.issue = String(number);
      if (request.ref) inputs.ref = request.ref;
    }
    await api(dispatcher, 'POST', `/repos/${harness}/actions/workflows/${workflow}/dispatches`, { ref, inputs });
    console.log(`${where}: started ${workflow} ${JSON.stringify(inputs)}`);
    await react(comment, 'eyes');
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`poll.js: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { parseRequest, plan };
