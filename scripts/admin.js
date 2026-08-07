#!/usr/bin/env node
/**
 * Admin CLI for the one manual operation the cookie-only identity design
 * creates: a name orphaned by someone clearing their cookies.
 *
 *   node scripts/admin.js list
 *   node scripts/admin.js release "Michael"
 *
 * On mktools:
 *   docker exec rev-trac-racer node scripts/admin.js release "Michael"
 */
const { createStore } = require('../store.js');
const { createProfiles } = require('../profiles.js');

const store = createStore();
const profiles = createProfiles(store);
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'list') {
  const rows = Object.entries(store.data.profiles)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (b.wins - a.wins) || (b.races - a.races));
  if (!rows.length) return console.log('no profiles yet');
  console.log('name              races  wins  podiums  id');
  for (const r of rows) {
    console.log(
      `${String(r.name ?? '(unclaimed)').padEnd(17)}${String(r.races).padStart(5)}` +
      `${String(r.wins).padStart(6)}${String(r.podiums).padStart(9)}  ${r.id}`
    );
  }
} else if (cmd === 'release') {
  const res = profiles.release(arg);
  console.log(res.ok ? `released "${res.name}" (profile ${res.id} kept its stats)` : `error: ${res.error}`);
  process.exit(res.ok ? 0 : 1);
} else {
  console.log('usage: node scripts/admin.js list | release "<name>"');
  process.exit(1);
}
