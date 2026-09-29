//=============================================================================
// github.js - the REST calls the CI scripts make, and nothing more.
//=============================================================================

async function api(token, method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gg2-automated-testing',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

// Every page of a list endpoint.
async function all(token, url) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await api(token, 'GET', `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

function env(name) {
  if (!process.env[name]) throw new Error(`${name} is not set`);
  return process.env[name];
}

module.exports = { api, all, env };
