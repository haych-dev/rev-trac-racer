#!/usr/bin/env node
/**
 * Admin CLI for the one manual operation the cookie-only identity design
 * creates: a name orphaned by someone clearing their cookies.
 *
 *   node scripts/admin.js list
 *   node scripts/admin.js release "Michael"
 *
 * A running server holds the store as a single in-memory object and
 * overwrites the file on its next save. Editing the file from a second
 * process while the server is up is invisible to it and gets silently
 * reverted, so `release` refuses to run if something is listening on the
 * server's port (127.0.0.1:PORT, default 3000). `list` only reads, so it is
 * left unguarded; a slightly stale read is harmless.
 *
 * On the VPS, stop the service first so the one-off container is the only
 * thing touching the store, then start it back up:
 *
 *   cd /docker/rev-trac-racer
 *   docker compose -f docker-compose.vps.yml stop web
 *   docker compose -f docker-compose.vps.yml run --rm web node scripts/admin.js release "Michael"
 *   docker compose -f docker-compose.vps.yml start web
 *
 * `docker compose run` mounts the same named volume, so the one-off
 * container sees the same store. Note the guard below does NOT catch a
 * `docker compose run --rm` issued while the service is still up — that
 * one-off container has its own loopback and cannot see the running
 * service's listening socket — so always stop the service first as shown
 * above; don't rely on the guard to catch that case.
 *
 * Releasing a name does not touch the hall of fame: the profile keeps its
 * history, it just needs to pick a new name.
 */
const net = require('net');
const { createStore } = require('../lib/store.js');
const { createProfiles } = require('../lib/profiles.js');

const store = createStore();
const profiles = createProfiles(store);
const [cmd, arg] = process.argv.slice(2);

function serverIsUp(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 500 });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}

async function main() {
  if (cmd === 'list') {
    const rows = Object.entries(store.data.profiles)
      .map(([id, p]) => ({ id, ...p }))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (!rows.length) return console.log('no profiles yet');
    console.log('name              created     id');
    for (const r of rows) {
      const created = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '?';
      console.log(`${String(r.name ?? '(unclaimed)').padEnd(18)}${created}  ${r.id}`);
    }
  } else if (cmd === 'release') {
    const port = Number(process.env.PORT) || 3000;
    if (await serverIsUp(port)) {
      console.error(
        `error: a server is listening on 127.0.0.1:${port} — it owns the store in ` +
        `memory and would revert this on its next save. Stop it first (see the ` +
        `header of scripts/admin.js for the VPS procedure).`
      );
      process.exit(1);
    }
    const res = profiles.release(arg);
    console.log(res.ok ? `released "${res.name}" (profile ${res.id} keeps its history)` : `error: ${res.error}`);
    process.exit(res.ok ? 0 : 1);
  } else {
    console.log('usage: node scripts/admin.js list | release "<name>"');
    process.exit(1);
  }
}

main();
