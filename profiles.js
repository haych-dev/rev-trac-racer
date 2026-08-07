/**
 * Driver identity. A profile is a random id held by the browser in a signed
 * httpOnly cookie; a name is *owned* by that id. This is what makes the
 * leaderboard meaningful — impersonation needs cookie theft, not a text field.
 */
const crypto = require('crypto');

const COOKIE = 'rtr_pid';
const NAME_RE = /^[A-Za-z0-9 _-]{3,16}$/;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function createProfiles(store) {
  // Persisted so a restart does not invalidate everyone's identity. The env
  // override exists for the case where you want to rotate it deliberately.
  const secret = process.env.RTR_SECRET || store.data.secret;

  function sign(id) {
    return crypto.createHmac('sha256', secret).update(String(id)).digest('hex').slice(0, 32);
  }

  function verify(token) {
    if (typeof token !== 'string') return null;
    const i = token.lastIndexOf('.');
    if (i <= 0) return null;
    const id = token.slice(0, i);
    const sig = token.slice(i + 1);
    const want = sign(id);
    // Compare BYTE length, not string .length: a crafted multi-byte/astral
    // signature can have the same UTF-16 .length as `want` while producing a
    // differently-sized Buffer, which makes timingSafeEqual throw instead of
    // returning false. Guard on the actual buffer sizes it will compare.
    const sigBuf = Buffer.from(sig);
    const wantBuf = Buffer.from(want);
    if (sigBuf.length !== wantBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, wantBuf)) return null;
    return id;
  }

  function mint() {
    const id = crypto.randomUUID();
    store.data.profiles[id] = {
      name: null, nameLower: null, createdAt: Date.now(),
      races: 0, wins: 0, podiums: 0,
    };
    store.save();
    return { id, token: `${id}.${sign(id)}` };
  }

  function get(id) {
    // hasOwnProperty guard, not a bare `profiles[id]` truthiness check: without
    // it, get('__proto__') would return Object.prototype (inherited, truthy),
    // and claim() would then write name/nameLower onto Object.prototype itself.
    // claim() and holderOf() both route profile lookups through this function
    // (holderOf additionally only ever sees Object.entries()'s own-enumerable
    // keys, which can't include an inherited '__proto__' either), so guarding
    // here is sufficient.
    if (!id || !Object.prototype.hasOwnProperty.call(store.data.profiles, id)) return null;
    return store.data.profiles[id];
  }

  function validateName(raw) {
    const name = String(raw ?? '').trim();
    if (!NAME_RE.test(name)) {
      return {
        ok: false, code: 400,
        error: 'Name must be 3-16 characters: letters, numbers, space, _ or -',
      };
    }
    return { ok: true, name };
  }

  function holderOf(nameLower, exceptId) {
    for (const [pid, p] of Object.entries(store.data.profiles)) {
      if (pid !== exceptId && p.nameLower === nameLower) return pid;
    }
    return null;
  }

  function claim(id, raw) {
    const p = get(id);
    if (!p) return { ok: false, code: 400, error: 'No profile' };
    const v = validateName(raw);
    if (!v.ok) return v;
    const lower = v.name.toLowerCase();
    if (holderOf(lower, id)) {
      return { ok: false, code: 409, error: 'That name is taken' };
    }
    // Overwriting nameLower is what frees the previous name.
    p.name = v.name;
    p.nameLower = lower;
    store.save();
    return { ok: true, name: v.name };
  }

  function release(name) {
    const lower = String(name || '').trim().toLowerCase();
    if (!lower) return { ok: false, error: 'Give a name to release' };
    const pid = holderOf(lower, null);
    if (!pid) return { ok: false, error: 'No profile holds that name' };
    const p = store.data.profiles[pid];
    const had = p.name;
    p.name = null;
    p.nameLower = null;
    store.save();
    return { ok: true, id: pid, name: had };
  }

  return { COOKIE, sign, verify, mint, get, claim, release, validateName };
}

module.exports = { createProfiles, parseCookies, COOKIE, NAME_RE };
