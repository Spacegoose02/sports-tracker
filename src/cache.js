// Tiny in-memory TTL cache so we don't hammer ESPN/ncaa-api on every
// browser poll. Keyed by an arbitrary string, values expire after
// CACHE_TTL_SECONDS (default 20s), which keeps "live" data fresh while
// still saving a request every time two browser tabs happen to poll
// at once.

const store = new Map();

function ttlMs() {
  const secs = Number(process.env.CACHE_TTL_SECONDS || 20);
  return secs * 1000;
}

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function set(key, value, ttlOverrideMs) {
  store.set(key, {
    value,
    expires: Date.now() + (ttlOverrideMs || ttlMs()),
  });
}

async function getOrFetch(key, fetcher, ttlOverrideMs) {
  const cached = get(key);
  if (cached !== undefined) return cached;
  const value = await fetcher();
  set(key, value, ttlOverrideMs);
  return value;
}

module.exports = { get, set, getOrFetch };
