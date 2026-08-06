/** Capacity test: 8 players allowed, 9th rejected. Usage: node test/capacity.js [url] */
const { io } = require('socket.io-client');
const URL = process.argv[2] || 'http://localhost:4100';

const sockets = [];
function connect() {
  return new Promise((res) => {
    const s = io(URL, { transports: ['websocket'] });
    sockets.push(s);
    s.on('connect', () => res(s));
  });
}

(async () => {
  const host = await connect();
  const code = await new Promise((res) =>
    host.emit('createRoom', { name: 'Host' }, (r) => res(r.code)));
  console.log('room', code);

  let joined = 1;
  for (let i = 2; i <= 8; i++) {
    const s = await connect();
    const ok = await new Promise((res) =>
      s.emit('joinRoom', { code, name: `P${i}` }, (r) => res(r.ok)));
    if (ok) joined++;
  }
  console.log(`players joined: ${joined} (expect 8)`);

  const ninth = await connect();
  const r9 = await new Promise((res) =>
    ninth.emit('joinRoom', { code, name: 'P9' }, (r) => res(r)));
  console.log(`9th join rejected: ${!r9.ok} (${r9.error || 'no error'})`);

  // everyone readies, host starts, then a join attempt mid-race
  sockets.slice(1, 8).forEach((s) => s.emit('toggleReady'));
  await new Promise((r) => setTimeout(r, 300));
  host.emit('startRace');
  await new Promise((r) => setTimeout(r, 500));
  const rMid = await new Promise((res) =>
    ninth.emit('joinRoom', { code, name: 'P9' }, (r) => res(r)));
  console.log(`mid-race join rejected: ${!rMid.ok} (${rMid.error || 'no error'})`);

  const pass = joined === 8 && !r9.ok && !rMid.ok;
  console.log(pass ? 'PASS' : 'FAIL');
  sockets.forEach((s) => s.disconnect());
  process.exit(pass ? 0 : 1);
})();
