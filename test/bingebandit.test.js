const test = require('node:test');
const assert = require('node:assert');
require('./helpers'); // points the SQLite file at a temp folder
const { createApp } = require('../src/app');
const { bingeBanditConfig, cleanLinks } = require('../src/bingebandit');

// A fake BingeBandit: answers ESPN2 with channel 206, records calls.
function fakeBingeBandit() {
  const f = {
    calls: [],
    status: 200,
    fetch: async (url, opts) => {
      f.calls.push({ url, key: opts.headers['X-Api-Key'] });
      if (f.status !== 200) return { ok: false, status: f.status, json: async () => ({}) };
      const asked = new URL(url).searchParams.getAll('network');
      const links = asked.filter((n) => n === 'ESPN2').map((n) => ({ network: n, channel: { id: 42, number: 206, name: 'US: ESPN 2 HD' }, path: '/live/42' }));
      return { ok: true, status: 200, json: async () => ({ links }) };
    },
  };
  return f;
}

async function start(env, bb, clock = { t: 1e12 }) {
  const app = createApp({ env: { NODE_ENV: 'test', ...env }, logger: { warn() {} }, bingebandit: { fetch: bb.fetch, now: () => clock.t } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    get: async (qs) => (await fetch(`http://127.0.0.1:${server.address().port}/api/bingebandit/watch?${qs}`)).json(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('config: off without an address, key falls back to the relay key', () => {
  assert.strictEqual(bingeBanditConfig({}), null);
  assert.strictEqual(bingeBanditConfig({ BINGEBANDIT_URL: 'ftp://x' }), null);
  assert.deepStrictEqual(bingeBanditConfig({ BINGEBANDIT_URL: 'http://192.168.1.10:8484/', RELAY_API_KEY: 'r' }), {
    base: 'http://192.168.1.10:8484', linkBase: 'http://192.168.1.10:8484', key: 'r',
  });
  const c = bingeBanditConfig({ BINGEBANDIT_URL: 'http://bb:8484', BINGEBANDIT_LINK_URL: 'https://tv.example.com', BINGEBANDIT_API_KEY: 'k', RELAY_API_KEY: 'r' });
  assert.strictEqual(c.key, 'k');
  assert.strictEqual(c.linkBase, 'https://tv.example.com');
});

test('only well-formed /live/{id} links for networks asked about are kept', () => {
  const links = cleanLinks({ links: [
    { network: 'ESPN2', channel: { number: 206, name: 'ESPN2' }, path: '/live/42' },
    { network: 'ESPN2', channel: {}, path: 'https://evil.example/live/1' },
    { network: 'FOX', channel: {}, path: '/live/7' },
    { network: 'ABC', channel: {}, path: '/live/9/../admin' },
  ] }, 'http://bb', ['espn2', 'ABC']);
  assert.deepStrictEqual(links, [{ network: 'ESPN2', channel: { number: 206, name: 'ESPN2' }, url: 'http://bb/live/42' }]);
});

test('watch links are off until BINGEBANDIT_URL is set', async () => {
  const bb = fakeBingeBandit();
  const app = await start({ RELAY_API_KEY: 'r' }, bb);
  try {
    assert.deepStrictEqual(await app.get('network=ESPN2'), { links: [] });
    assert.strictEqual(bb.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('watch links ask BingeBandit with the key, cache, and go quiet when it fails', async () => {
  const bb = fakeBingeBandit();
  const clock = { t: 1e12 };
  const app = await start({ BINGEBANDIT_URL: 'http://bb.test:8484', BINGEBANDIT_LINK_URL: 'https://tv.example.com', RELAY_API_KEY: 'relay-key' }, bb, clock);
  try {
    const first = await app.get('network=ESPN2&network=ABC');
    assert.deepStrictEqual(first.links, [{ network: 'ESPN2', channel: { number: 206, name: 'US: ESPN 2 HD' }, url: 'https://tv.example.com/live/42' }]);
    assert.strictEqual(bb.calls.length, 1);
    assert.strictEqual(bb.calls[0].key, 'relay-key');
    assert.match(bb.calls[0].url, /^http:\/\/bb\.test:8484\/api\/sports\/watch-links\?network=ESPN2&network=ABC$/);

    await app.get('network=ABC&network=espn2'); // same set, another order: cached
    assert.strictEqual(bb.calls.length, 1);

    clock.t += 6 * 60 * 1000;
    bb.status = 500;
    assert.deepStrictEqual(await app.get('network=ESPN2&network=ABC'), { links: [] });
    assert.strictEqual(bb.calls.length, 2);
  } finally {
    await app.close();
  }
});
