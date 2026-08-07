/**
 * Token bucket. `now` is injectable so the tests do not need to sleep.
 *
 * These are DoS backstops, not security boundaries — see the spec. The real
 * integrity guarantees come from signed profile ownership and the 2+ distinct
 * profile rule, neither of which depends on request rate or IP.
 */
function createLimiter({ capacity, refillPerSec }) {
  const buckets = new Map(); // key -> { tokens, last }

  function allow(key, now = Date.now()) {
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, last: now };
      buckets.set(key, b);
    }
    const elapsed = Math.max(0, now - b.last) / 1000;
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  return {
    allow,
    forget(key) { buckets.delete(key); },
    // Buckets are created per socket id and per IP; without this the map grows
    // for the process lifetime.
    sweep(maxIdleMs, now = Date.now()) {
      for (const [k, b] of buckets) {
        if (now - b.last > maxIdleMs) buckets.delete(k);
      }
    },
    size() { return buckets.size; },
  };
}

module.exports = { createLimiter };
