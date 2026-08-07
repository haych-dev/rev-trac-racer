/** Unit tests for store.js and profiles.js. Usage: node test/store.js */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtr-store-'));
const file = path.join(tmpdir, 'store.json');

const { createStore, MAX_RACES } = require('../store.js');

const checks = [];
function check(label, cond) {
  checks.push({ label, cond: !!cond });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
}

console.log('store.js');

// fresh store
const s1 = createStore(file);
check('fresh store has version 1', s1.data.version === 1);
check('fresh store generates a secret', typeof s1.data.secret === 'string' && s1.data.secret.length >= 32);
check('fresh store has empty collections',
  Object.keys(s1.data.profiles).length === 0 && s1.data.races.length === 0);
check('no file written until save()', !fs.existsSync(file));

// round-trip
s1.data.profiles.abc = { name: 'Michael', nameLower: 'michael', createdAt: 1, races: 2, wins: 1, podiums: 1 };
s1.save();
check('save() creates the file', fs.existsSync(file));
check('save() leaves no .tmp behind', !fs.existsSync(file + '.tmp'));
const s2 = createStore(file);
check('reload round-trips a profile', s2.data.profiles.abc.name === 'Michael');
check('reload keeps the same secret', s2.data.secret === s1.data.secret);

// races cap
const s3 = createStore(path.join(tmpdir, 'cap.json'));
for (let i = 0; i < MAX_RACES + 50; i++) s3.data.races.push({ at: i });
s3.save();
const s4 = createStore(path.join(tmpdir, 'cap.json'));
check(`load caps races at ${MAX_RACES}`, s4.data.races.length === MAX_RACES);
check('load keeps the most recent races', s4.data.races[s4.data.races.length - 1].at === MAX_RACES + 49);

// a stale .tmp from a crashed write must not be loaded as the real file
const crashFile = path.join(tmpdir, 'crash.json');
const good = createStore(crashFile);
good.data.profiles.keep = { name: 'Keeper', nameLower: 'keeper', createdAt: 1, races: 0, wins: 0, podiums: 0 };
good.save();
fs.writeFileSync(crashFile + '.tmp', '{ this is a half-written file');
const afterCrash = createStore(crashFile);
check('a stale .tmp does not corrupt the load', afterCrash.data.profiles.keep.name === 'Keeper');

// corrupt main file is moved aside, not fatal
const badFile = path.join(tmpdir, 'bad.json');
fs.writeFileSync(badFile, 'not json at all');
const recovered = createStore(badFile);
check('corrupt store recovers to a fresh one', Object.keys(recovered.data.profiles).length === 0);
check('corrupt store is preserved alongside',
  fs.readdirSync(tmpdir).some((f) => f.startsWith('bad.json.corrupt-')));

// missing keys are backfilled rather than crashing
const partialFile = path.join(tmpdir, 'partial.json');
fs.writeFileSync(partialFile, JSON.stringify({ version: 1, profiles: { x: {} } }));
const partial = createStore(partialFile);
check('missing records/races are backfilled',
  typeof partial.data.records === 'object' && Array.isArray(partial.data.races));
check('missing secret is regenerated', typeof partial.data.secret === 'string' && partial.data.secret.length >= 32);

const failed = checks.filter((c) => !c.cond);
console.log(failed.length ? `FAIL (${failed.length}/${checks.length})` : `PASS (${checks.length} checks)`);
process.exit(failed.length ? 1 : 0);
