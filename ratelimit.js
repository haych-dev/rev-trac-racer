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
    // Never let a rewound clock regress the stored timestamp. Date.now() moves
    // backward under NTP correction, and a plain `b.last = now` would then
    // credit the next forward call with refill for time that never passed.
    b.last = Math.max(now, b.last);
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
