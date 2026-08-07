/** Capacity test: 8 players allowed, 9th rejected. Usage: node test/capacity.js [url]
 * Run with RTR_STORE_PATH pointed at a throwaway file so test drivers never
 * land on the real leaderboard.
 */
const { io } = require('socket.io-client');
const { makeProfile } = require('./helpers/profile.js');
const URL = process.argv[2] || 'http://localhost:4100';

const sockets = [];
function connect(cookie) {
  return new Promise((res) => {
    const s = io(URL, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
    sockets.push(s);
    s.on('connect', () => res(s));
  });
}

(async () => {
  const host = await connect(await makeProfile(URL, 'HostPlayer'));
  const code = await new Promise((res) => host.emit('createRoom', {}, (r) => res(r.code)));
  console.log('room', code);

  let joined = 1;
  for (let i = 2; i <= 8; i++) {
    const s = await connect(await makeProfile(URL, `Player${i}`));
    const ok = await new Promise((res) => s.emit('joinRoom', { code }, (r) => res(r.ok)));
    if (ok) joined++;
  }
  console.log(`players joined: ${joined} (expect 8)`);

  const ninth = await connect(await makeProfile(URL, 'Player9'));
  const r9 = await new Promise((res) => ninth.emit('joinRoom', { code }, (r) => res(r)));
  console.log(`9th join rejected: ${!r9.ok} (${r9.error || 'no error'})`);

  sockets.slice(1, 8).forEach((s) => s.emit('toggleReady'));
  await new Promise((r) => setTimeout(r, 300));
  host.emit('startRace');
  await new Promise((r) => setTimeout(r, 500));
  const rMid = await new Promise((res) => ninth.emit('joinRoom', { code }, (r) => res(r)));
  console.log(`mid-race join rejected: ${!rMid.ok} (${rMid.error || 'no error'})`);

  const pass = joined === 8 && !r9.ok && !rMid.ok;
  console.log(pass ? 'PASS' : 'FAIL');
  sockets.forEach((s) => s.disconnect());
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
