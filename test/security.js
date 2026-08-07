/**
 * Integration tests for the hardening claims in the spec.
 *
 * Needs a FRESH server AND a fresh store on every run: the mint-throttle check
 * deliberately burns this IP's 30-token budget, and the standings check asserts
 * an empty board. Re-running against a warm process or a surviving store file
 * fails at bootstrap.
 *
 *   rm -f /tmp/rtr-sec.json
 *   RTR_STORE_PATH=/tmp/rtr-sec.json PORT=4200 LAPS=1 node server.js &
 *   node test/security.js http://localhost:4200
 */
const { io } = require('socket.io-client');

const URL = process.argv[2] || 'http://localhost:4200';

// Several awaits below can hang rather than fail — a socket that never connects,
// a 'lobby' event that never arrives. A hung suite is worse than a failed one,
// so cap the whole run. This lives entirely in the test; production is untouched.
setTimeout(() => {
  console.log('FAIL (timed out after 30s — is the server fresh? this suite burns its IP mint budget)');
  process.exit(1);
}, 30000).unref();

const checks = [];
function check(label, cond) {
  checks.push({ label, cond: !!cond });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
}

async function bootstrap() {
  const res = await fetch(`${URL}/api/profile/me`);
  const setCookie = res.headers.get('set-cookie') || '';
  const body = await res.json();
  return { cookie: setCookie.split(';')[0], raw: setCookie, body };
}
async function claim(cookie, name) {
  const res = await fetch(`${URL}/api/profile/name`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name }),
  });
  return { status: res.status, body: await res.json() };
}
function connect(cookie) {
  return new Promise((resolve, reject) => {
    const opts = { transports: ['websocket'], reconnection: false };
    if (cookie) opts.extraHeaders = { Cookie: cookie };
    const s = io(URL, opts);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
function emit(sock, event, payload) {
  return new Promise((resolve) => sock.emit(event, payload, resolve));
}

(async () => {
  const sockets = [];
  try {
    console.log('profile bootstrap');
    const first = await bootstrap();
    check('bootstrap sets a cookie', first.cookie.startsWith('rtr_pid='));
    check('a new profile starts nameless', first.body.name === null);
    const again = await fetch(`${URL}/api/profile/me`, { headers: { cookie: first.cookie } });
    const againBody = await again.json();
    check('an existing cookie keeps its id', againBody.id === first.body.id);
    // These three attributes are the one requirement whose failure breaks
    // identity silently for every player, so pin them rather than eyeballing
    // curl output. Secure in particular MUST be absent: the host serves plain
    // HTTP over LAN, and a Secure cookie would simply never be sent.
    check('the cookie is HttpOnly', /HttpOnly/i.test(first.raw));
    check('the cookie is NOT Secure', !/;\s*Secure/i.test(first.raw));
    check('the cookie has a 5-year Max-Age', /Max-Age=157680000/.test(first.raw));

    console.log('name claiming');
    check('a 2-char name is rejected', (await claim(first.cookie, 'ab')).status === 400);
    check('punctuation is rejected', (await claim(first.cookie, 'Bad!')).status === 400);
    const ok = await claim(first.cookie, 'SecTester');
    check('a valid name is accepted', ok.status === 200 && ok.body.name === 'SecTester');
    const second = await bootstrap();
    const dupe = await claim(second.cookie, 'sectester');
    check('a taken name returns 409 case-insensitively', dupe.status === 409);

    console.log('socket refusals');
    const nameless = await connect(second.cookie);
    sockets.push(nameless);
    const r1 = await emit(nameless, 'createRoom', {});
    check('a valid cookie with no name is refused', r1.ok === false);
    check('...with "Claim a name first"', r1.error === 'Claim a name first');

    const anon = await connect(null);
    sockets.push(anon);
    const r2 = await emit(anon, 'createRoom', {});
    check('a cookieless socket is refused', r2.ok === false && r2.error === 'No profile');

    const forged = await connect('rtr_pid=11111111-1111-1111-1111-111111111111.deadbeefdeadbeefdeadbeefdeadbeef');
    sockets.push(forged);
    const r3 = await emit(forged, 'createRoom', {});
    check('a forged cookie is refused', r3.ok === false && r3.error === 'Invalid profile');

    console.log('the client cannot choose its own name');
    const good = await connect(first.cookie);
    sockets.push(good);
    const created = await emit(good, 'createRoom', { name: 'Imposter' });
    check('createRoom succeeds with a claimed profile', created.ok === true);
    const lobby = await new Promise((res) => good.once('lobby', res));
    check('the server ignores a client-supplied name',
      lobby.players.length === 1 && lobby.players[0].name === 'SecTester');
    check('lobby state leaks no profile id',
      !JSON.stringify(lobby).includes(first.body.id));

    console.log('rate limiting');
    // input/useItem floods are dropped SILENTLY, so "was it dropped" is not
    // observable from a client. What IS observable is that the socket survives
    // and keeps answering — a real robustness property, but NOT proof that the
    // limiter exists. The limiter is proven below, via the one guard that
    // reports over-limit back to the caller.
    for (let i = 0; i < 400; i++) good.emit('input', { up: true, down: false, left: false, right: false });
    await new Promise((r) => setTimeout(r, 300));
    check('an input flood does not kill the socket', good.connected === true);
    const stillWorks = await emit(good, 'joinRoom', { code: created.code });
    check('the socket still answers after a flood', typeof stillWorks === 'object');

    // createRoom/joinRoom is capped at 5 per 10s per socket AND reports
    // over-limit to the caller, so this is the limiter's observable proof.
    const burst = [];
    for (let i = 0; i < 9; i++) burst.push(await emit(good, 'joinRoom', { code: created.code }));
    check('a joinRoom burst is rate limited',
      burst.some((r) => r && r.error === 'Slow down'));

    console.log('debug route');
    const dbg = await fetch(`${URL}/debug/rooms`);
    check('/debug/rooms 404s without RTR_DEBUG=1', dbg.status === 404);

    console.log('leaderboard read path');
    const lb = await fetch(`${URL}/api/leaderboard`);
    const lbBody = await lb.json();
    check('/api/leaderboard responds 200', lb.status === 200);
    check('/api/leaderboard has the expected shape',
      Array.isArray(lbBody.standings) && typeof lbBody.records === 'object');
    // No race finishes in this suite, so standings is empty here and a
    // "contains no pid" assertion would pass even if view() leaked every id.
    // Assert the precondition instead; the real leak check lives in
    // test/bots.js, which reads this endpoint after a genuine race.
    check('standings is empty before any race has finished', lbBody.standings.length === 0);

    console.log('mint throttling');
    // The per-IP limits key off ipOf(), so a caller must not be able to set that
    // key. X-Forwarded-For is pure client input unless a trusted proxy sets it,
    // and this app publishes its port directly. If ipOf trusted the header,
    // rotating it would hand out a fresh 30-token bucket per value and every
    // per-IP limit would enforce nothing. Runs before the plain mint check so it
    // has to burn the real bucket through rotation to pass — which is the point.
    let xffLimited = false;
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${URL}/api/profile/me`, {
        headers: { 'x-forwarded-for': `1.2.3.${i}` },
      });
      if (res.status === 429) { xffLimited = true; break; }
    }
    check('a rotating X-Forwarded-For does not buy a fresh mint bucket', xffLimited);

    // Minting is the only unauthenticated path that writes to the store, so it
    // must throttle. Run this last — it burns this IP's mint budget.
    let mintLimited = false;
    for (let i = 0; i < 40; i++) {
      if ((await fetch(`${URL}/api/profile/me`)).status === 429) { mintLimited = true; break; }
    }
    check('profile minting is rate limited', mintLimited);
  } catch (e) {
    console.error('threw:', e && e.message);
    check('no exception during the run', false);
  }

  sockets.forEach((s) => s.disconnect());
  const failed = checks.filter((c) => !c.cond);
  console.log(failed.length ? `FAIL (${failed.length}/${checks.length})` : `PASS (${checks.length} checks)`);
  process.exit(failed.length ? 1 : 0);
})();
