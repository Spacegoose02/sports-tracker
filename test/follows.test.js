const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-follows-'));

// shared.js with a working in-memory localStorage.
function loadSharedWithStorage(search = '') {
  const store = new Map();
  const sandbox = {
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    location: { search, pathname: '/' },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    URL,
    URLSearchParams,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shared.js'), 'utf8')}\nthis.CFB = CFB;`, sandbox);
  return { CFB: sandbox.CFB, store };
}

test('follows are per sport and survive a toggle round-trip', () => {
  const { CFB } = loadSharedWithStorage('?sport=cfb');
  CFB.follows.add({ id: '259', name: 'Virginia Tech Hokies' });
  CFB.follows.add({ id: '2', name: 'Boston Celtics' }, 'nba');
  assert.deepStrictEqual([...CFB.follows.ids()], ['259']);
  assert.deepStrictEqual([...CFB.follows.ids('nba')], ['2']);
  assert.strictEqual(CFB.follows.toggle({ id: '259' }), false);
  assert.strictEqual(CFB.follows.has('259'), false);
  assert.strictEqual(CFB.follows.toggle({ id: '259', name: 'VT' }), true);
  assert.strictEqual(CFB.follows.has('259'), true);
});

test('the server favorite is followed once, and unfollowing it sticks', () => {
  const { CFB } = loadSharedWithStorage();
  CFB.follows.seedDefault('259', 'Virginia Tech Hokies');
  assert.ok(CFB.follows.has('259', 'cfb'));
  CFB.follows.remove('259', 'cfb');
  CFB.follows.seedDefault('259', 'Virginia Tech Hokies');
  assert.ok(!CFB.follows.has('259', 'cfb'));
});

test('corrupt storage is ignored', () => {
  const { CFB, store } = loadSharedWithStorage();
  store.set('tracker-follows', '{not json');
  assert.strictEqual(CFB.follows.list('cfb').length, 0);
});

test('game cards highlight any followed team', () => {
  const { CFB } = loadSharedWithStorage();
  const game = { id: '1', status: { state: 'pre' }, away: { id: '52', name: 'Florida State' }, home: { id: '1', name: 'Other' } };
  assert.match(CFB.gameCardHtml(game, { followedIds: new Set(['52']) }), /is-favorite/);
  assert.doesNotMatch(CFB.gameCardHtml(game, { followedIds: new Set(['259']) }), /is-favorite/);
});

test('team news merges followed teams, tags each item and drops duplicates', async () => {
  const calls = [];
  require.cache[require.resolve('node-fetch')] = {
    id: 'node-fetch', filename: require.resolve('node-fetch'), loaded: true,
    exports: async (url) => {
      calls.push(String(url));
      const team = new URL(String(url)).searchParams.get('team');
      const article = (n, when) => ({ headline: `Story ${n}`, published: when, links: { web: { href: `https://www.espn.com/story/${n}` } } });
      const articles = team === '259'
        ? [article('vt', '2026-11-01T10:00:00Z'), article('shared', '2026-11-01T12:00:00Z')]
        : [article('fsu', '2026-11-01T11:00:00Z'), article('shared', '2026-11-01T12:00:00Z')];
      return { ok: true, status: 200, json: async () => ({ articles }) };
    },
  };
  delete require.cache[require.resolve('../src/espn')];
  delete require.cache[require.resolve('../src/datasource')];
  delete require.cache[require.resolve('../src/routes/api')];
  const express = require('express');
  const app = express();
  app.use('/api', require('../src/routes/api'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const data = await (await fetch(`${base}/api/news/teams?teams=259,52,259,../x`)).json();
    assert.deepStrictEqual(data.items.map((i) => i.title), ['Story shared', 'Story fsu', 'Story vt']);
    assert.deepStrictEqual(data.items.map((i) => i.teamId), ['259', '52', '259']);
    assert.strictEqual(calls.length, 2, 'duplicate and invalid ids are dropped before calling ESPN');
    assert.ok(calls.every((u) => u.includes('/football/college-football/news?')));
    assert.deepStrictEqual(await (await fetch(`${base}/api/news/teams`)).json(), { items: [] });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// shared.js with storage and a fake account API.
function loadSharedWithAccount(server) {
  const store = new Map();
  const calls = [];
  const sandbox = {
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    location: { search: '', pathname: '/' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async (url, opts = {}) => {
      const method = opts.method || 'GET';
      calls.push(`${method} ${url}`);
      const body = await server(method, url, opts.body ? JSON.parse(opts.body) : null);
      return { ok: true, status: 200, json: async () => body };
    },
    URL,
    URLSearchParams,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shared.js'), 'utf8')}\nthis.CFB = CFB;`, sandbox);
  return { CFB: sandbox.CFB, store, calls };
}

test('first sign-in on a device merges local follows; later loads take the account list', async () => {
  let serverList = [{ sport: 'nba', id: '2', name: 'Boston Celtics' }];
  const server = async (method, url, body) => {
    if (url === '/api/account/me') return { user: { id: 7, displayName: 'Sam' }, follows: serverList };
    if (url === '/api/account/follows/merge') { serverList = [...serverList, ...body.follows]; return { follows: serverList }; }
    if (method === 'POST' && url === '/api/account/follows') { serverList = [...serverList, body]; return { follows: serverList }; }
    if (method === 'DELETE') { serverList = serverList.filter((t) => !url.endsWith(`/${t.sport}/${t.id}`)); return { follows: serverList }; }
    if (url === '/api/account/logout') return { ok: true };
    return {};
  };
  const { CFB, store, calls } = loadSharedWithAccount(server);
  CFB.follows.add({ id: '259', name: 'Virginia Tech Hokies' }, 'cfb');
  await CFB.account.load();
  assert.ok(calls.includes('POST /api/account/follows/merge'));
  assert.deepStrictEqual([...CFB.follows.all().map((t) => `${t.sport}:${t.id}`)], ['nba:2', 'cfb:259']);
  assert.strictEqual(store.get('tracker-follows-owner'), '7');

  // Removed on another device: the next load drops it here, no re-merge.
  serverList = serverList.filter((t) => t.id !== '2');
  calls.length = 0;
  await CFB.account.load(true);
  assert.ok(!calls.includes('POST /api/account/follows/merge'));
  assert.deepStrictEqual([...CFB.follows.all().map((t) => t.id)], ['259']);

  // Follow changes are sent to the account.
  CFB.follows.add({ id: '52', name: 'Florida State' }, 'cfb');
  CFB.follows.remove('259', 'cfb');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(serverList.map((t) => t.id), ['52']);

  // Signing out clears this device's copy.
  await CFB.account.logout();
  assert.strictEqual(CFB.follows.all().length, 0);
  assert.strictEqual(store.has('tracker-follows-owner'), false);
});
