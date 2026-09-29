//=============================================================================
// issue.js - the repro script in a GitHub issue or pull request thread.
//
// A repro travels in the thread as a fenced block tagged `js repro`
// (docs/WORKFLOW.md). This finds the most recent one - in the last comment
// that has one, else the opening post - and says where it came from, so a
// report can link the exact script it ran.
//
// A maintainer reads the script before asking for it to be run, so what runs
// must be what they read. `asOf` is the moment they asked: anything posted
// later is ignored, and a block edited later is refused rather than run.
// Edit times are only in GitHub's GraphQL API, which needs a token even for a
// public repo.
//=============================================================================

const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ```js repro, ```javascript repro, ~~~ js repro ... The closing fence must
// match the opening one and be at least as long.
const FENCE = /^( {0,3})(([`~])\3{2,})[ \t]*(?:js|javascript)[ \t]+repro[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\2\3*[ \t]*(?:\r?\n|$)/gm;

// Every repro block in a piece of Markdown, in order.
function reproBlocks(markdown) {
  const blocks = [];
  for (const m of (markdown || '').matchAll(FENCE)) {
    // A fence indented by n spaces has up to n removed from each line.
    const indent = m[1].length;
    blocks.push(indent ? m[4].replace(new RegExp(`^ {0,${indent}}`, 'gm'), '') : m[4]);
  }
  return blocks;
}

// "owner/repo#12", or an issue or pull request URL.
function parseTarget(text) {
  const m =
    /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(text) ||
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\/?(?:#.*)?$/.exec(text);
  if (!m) throw new Error(`not an issue: ${text} (expected owner/repo#N or an issue URL)`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  throw new Error('reading an issue needs a GitHub token: set GITHUB_TOKEN, or log in with gh');
}

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token()}`, 'Content-Type': 'application/json', 'User-Agent': 'gg2-automated-testing' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    throw new Error(`GitHub: ${(body.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}`}`);
  }
  return body.data;
}

const POST = 'url body createdAt lastEditedAt authorAssociation author { login }';
const COMMENTS = `comments(first: 100, after: $after) { nodes { ${POST} } pageInfo { hasNextPage endCursor } }`;
const QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      ... on Issue { ${POST} ${COMMENTS} }
      ... on PullRequest {
        ${POST} ${COMMENTS}
        closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } }
      }
    }
  }
}`;

// The opening post and every comment, oldest first, and for a pull request
// the issues in its own repo that it says it closes ("Fixes #12").
async function thread({ owner, repo, number }) {
  const posts = [];
  let closes = [];
  let after = null;
  for (;;) {
    const data = await graphql(QUERY, { owner, repo, number, after });
    const item = data.repository && data.repository.issueOrPullRequest;
    if (!item) throw new Error(`${owner}/${repo}#${number} does not exist`);
    if (!after) {
      posts.push(item);
      closes = ((item.closingIssuesReferences || {}).nodes || [])
        .filter((i) => i.repository.nameWithOwner.toLowerCase() === `${owner}/${repo}`.toLowerCase())
        .map((i) => i.number);
    }
    posts.push(...item.comments.nodes);
    if (!item.comments.pageInfo.hasNextPage) return { posts, closes };
    after = item.comments.pageInfo.endCursor;
  }
}

// Pick the repro out of a thread: the last block of the last post that has
// one, among the posts made by `asOf`. Pure, so the selftest can check it.
function pick(posts, asOf) {
  const cutoff = asOf ? Date.parse(asOf) : Infinity;
  if (asOf && Number.isNaN(cutoff)) throw new Error(`--as-of is not a time: ${asOf}`);
  const eligible = posts.filter((p) => Date.parse(p.createdAt) <= cutoff);
  for (let i = eligible.length - 1; i >= 0; i--) {
    const post = eligible[i];
    const blocks = reproBlocks(post.body);
    if (!blocks.length) continue;
    if (post.lastEditedAt && Date.parse(post.lastEditedAt) > cutoff) {
      throw new Error(`the repro in ${post.url} was edited after ${asOf}; read it again before running it`);
    }
    // GitHub stores what was typed with CRLFs; the script, and so its hash,
    // should not depend on how it was posted.
    const code = blocks[blocks.length - 1].replace(/\r\n/g, '\n') + '\n';
    return {
      code,
      sha256: crypto.createHash('sha256').update(code).digest('hex'),
      url: post.url,
      author: post.author ? post.author.login : null,
      association: post.authorAssociation,
      postedAt: post.createdAt,
      editedAt: post.lastEditedAt,
    };
  }
  throw new Error('no ```js repro block in the thread' + (asOf ? ` as of ${asOf}` : ''));
}

// The repro for an issue - or for a pull request: one posted in its own thread
// if there is one, else the one in the issue it closes, so a fix is proven
// with the script that confirmed the bug. A block edited after `asOf` is an
// error wherever it is found, never a reason to look elsewhere.
async function findRepro(target, { asOf } = {}) {
  const { posts, closes } = await thread(target);
  try {
    return { ...pick(posts, asOf), from: target.number };
  } catch (e) {
    if (!/^no ```js repro block/.test(e.message) || !closes.length) throw e;
  }
  for (const number of closes) {
    const linked = await thread({ ...target, number });
    try {
      return { ...pick(linked.posts, asOf), from: number };
    } catch (e) {
      if (!/^no ```js repro block/.test(e.message)) throw e;
    }
  }
  throw new Error(`no \`\`\`js repro block in #${target.number} or the issues it closes (${closes.map((n) => `#${n}`).join(', ')})`);
}

module.exports = { reproBlocks, parseTarget, pick, findRepro };
