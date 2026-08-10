/** Capacity test: 8 players allowed, 9th rejected, one profile gets one seat.
 * Usage: node test/capacity.js [url]
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
  const hostCookie = await makeProfile(URL, 'HostPlayer');
  const host = await connect(hostCookie);
  // Every join rebroadcasts the lobby, so the last one we see is the live roster.
  let lobby = null;
  host.on('lobby', (l) => { lobby = l; });
  const code = await new Promise((res) => host.emit('createRoom', {}, (r) => res(r.code)));
  console.log('room', code);

  // One profile, one seat. A second socket carrying the SAME cookie is how a
  // single person would otherwise fill the grid and collect a set of standings
  // per seat — no forged cookie and no patched client needed.
  const twin = await connect(hostCookie);
  const rTwin = await new Promise((res) => twin.emit('joinRoom', { code }, (r) => res(r)));
  console.log(`same-cookie second seat rejected: ${!rTwin.ok} (${rTwin.error || 'no error'})`);

  const others = [];
  let joined = 1;
  for (let i = 2; i <= 8; i++) {
    const s = await connect(await makeProfile(URL, `Player${i}`));
    const ok = await new Promise((res) => s.emit('joinRoom', { code }, (r) => res(r.ok)));
    if (ok) { joined++; others.push(s); }
  }
  console.log(`players joined: ${joined} (expect 8)`);
  // The join ack can beat the lobby broadcast to this socket; let it land.
  await new Promise((r) => setTimeout(r, 300));
  const hostKept = !!lobby && lobby.players.length === joined
    && lobby.players.some((p) => p.id === host.id);
  console.log(`host kept its seat after the refusal: ${hostKept}`);

  const ninth = await connect(await makeProfile(URL, 'Player9'));
  const r9 = await new Promise((res) => ninth.emit('joinRoom', { code }, (r) => res(r)));
  console.log(`9th join rejected: ${!r9.ok} (${r9.error || 'no error'})`);

  others.forEach((s) => s.emit('toggleReady'));
  await new Promise((r) => setTimeout(r, 300));
  host.emit('startRace');
  await new Promise((r) => setTimeout(r, 500));
  const rMid = await new Promise((res) => ninth.emit('joinRoom', { code }, (r) => res(r)));
  console.log(`mid-race join rejected: ${!rMid.ok} (${rMid.error || 'no error'})`);

  const pass = joined === 8 && !r9.ok && !rMid.ok && hostKept
    && !rTwin.ok && rTwin.error === 'You are already in this room in another tab';
  console.log(pass ? 'PASS' : 'FAIL');
  sockets.forEach((s) => s.disconnect());
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
