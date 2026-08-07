/** Exit-race test: one of two racers exits mid-race; the other finishes.
 * Expect: finisher ranked 1st with a time, quitter listed as DNF.
 * Usage: node test/exit.js [url]  (run server with LAPS=1)
 * Run with RTR_STORE_PATH pointed at a throwaway file so test drivers never
 * land on the real leaderboard.
 */
const { io } = require('socket.io-client');
const RTMaps = require('../public/maps.js');
const { makeProfile } = require('./helpers/profile.js');

const URL = process.argv[2] || 'http://localhost:4100';
const MAP = RTMaps.MAPS[0];

let host, quitter;
let code = null;
let exited = false;
let sawQuitterRetired = false;

function wire() {
  host.on('connect', () => {
    host.emit('createRoom', {}, (r) => {
      if (!r.ok) { console.error('createRoom failed', r); process.exit(1); }
      code = r.code;
      quitter.emit('joinRoom', { code }, (j) => {
        if (!j.ok) { console.error('joinRoom failed', j); process.exit(1); }
        quitter.emit('toggleReady');
        setTimeout(() => host.emit('startRace'), 200);
      });
    });
  });

  host.on('state', (state) => {
    if (state.status !== 'racing') return;
    const me = state.players.find((p) => p.id === host.id);
    const q = state.players.find((p) => p.id === quitter.id);
    if (q && q.retired) sawQuitterRetired = true;

    if (!exited && state.now - state.raceStart > 2000) {
      exited = true;
      quitter.emit('exitRace');
      console.log('quitter exited at 2s');
    }

    if (me && !me.finished) {
      const near = RTMaps.closest(MAP.path, me.x, me.y);
      const tgt = RTMaps.pointAt(MAP.path, near.u + 0.035);
      const desired = Math.atan2(tgt.y - me.y, tgt.x - me.x);
      let da = desired - me.angle;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      host.emit('input', { up: true, down: false, left: da < -0.06, right: da > 0.06 });
    }
  });

  host.on('raceOver', ({ results }) => {
    console.log(JSON.stringify(results, null, 1));
    const pass =
      sawQuitterRetired &&
      results[0].name === 'Finisher' && results[0].finished && results[0].time > 0 &&
      results[1].name === 'Quitter' && !results[1].finished;
    console.log(pass ? 'PASS' : 'FAIL');
    host.disconnect(); quitter.disconnect();
    process.exit(pass ? 0 : 1);
  });
}

(async () => {
  const hostCookie = await makeProfile(URL, 'Finisher');
  const quitCookie = await makeProfile(URL, 'Quitter');
  host = io(URL, { transports: ['websocket'], extraHeaders: { Cookie: hostCookie } });
  quitter = io(URL, { transports: ['websocket'], extraHeaders: { Cookie: quitCookie } });
  wire();
})().catch((e) => { console.error(e.message); process.exit(1); });

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 90000);
