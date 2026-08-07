/**
 * Integration tests for the hardening claims in the spec.
 * Start a server first:
 *   RTR_STORE_PATH=/tmp/rtr-sec.json PORT=4200 LAPS=1 node server.js
 * Then: node test/security.js http://localhost:4200
 */
const { io } = require('socket.io-client');

const URL = process.argv[2] || 'http://localhost:4200';
const checks = [];
function check(label, cond) {
  checks.push({ label, cond: !!cond });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
}

async function bootstrap() {
  const res = await fetch(`${URL}/api/profile/me`);
  const setCookie = res.headers.get('set-cookie') || '';
  const body = await res.json();
  return { cookie: setCookie.split(';')[0], body };
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
    for (let i = 0; i < 400; i++) good.emit('input', { up: true, down: false, left: false, right: false });
    await new Promise((r) => setTimeout(r, 300));
    check('an input flood does not kill the socket', good.connected === true);
    const stillWorks = await emit(good, 'joinRoom', { code: created.code });
    check('the socket still answers after a flood', typeof stillWorks === 'object');

    console.log('debug route');
    const dbg = await fetch(`${URL}/debug/rooms`);
    check('/debug/rooms 404s without RTR_DEBUG=1', dbg.status === 404);

    console.log('leaderboard read path');
    const lb = await fetch(`${URL}/api/leaderboard`);
    const lbBody = await lb.json();
    check('/api/leaderboard responds 200', lb.status === 200);
    check('/api/leaderboard has the expected shape',
      Array.isArray(lbBody.standings) && typeof lbBody.records === 'object');
    check('/api/leaderboard leaks no profile id',
      !JSON.stringify(lbBody).includes(first.body.id));
  } catch (e) {
    console.error('threw:', e && e.message);
    check('no exception during the run', false);
  }

  sockets.forEach((s) => s.disconnect());
  const failed = checks.filter((c) => !c.cond);
  console.log(failed.length ? `FAIL (${failed.length}/${checks.length})` : `PASS (${checks.length} checks)`);
  process.exit(failed.length ? 1 : 0);
})();
