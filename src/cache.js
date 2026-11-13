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

// Requests for a key that's already being fetched share that one fetch
// (the game page asks for the same ESPN summary from two routes at once).
const inFlight = new Map();

// ttlOverrideMs may be a number, or a function of the fetched value that
// returns one, so finished games can be kept far longer than live ones.
async function getOrFetch(key, fetcher, ttlOverrideMs) {
  const cached = get(key);
  if (cached !== undefined) return cached;
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = (async () => {
    try {
      const value = await fetcher();
      const ttl = typeof ttlOverrideMs === 'function' ? ttlOverrideMs(value) : ttlOverrideMs;
      set(key, value, ttl);
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, pending);
  return pending;
}

module.exports = { get, set, getOrFetch };
