/**
 * Turns a finished race into durable standings and track records.
 *
 * Two deliberate asymmetries, both from the spec:
 *   - Track records count solo runs. A fast time is fast whether or not
 *     anyone else was on track.
 *   - Standings need 2+ distinct profiles that actually RACED, and each profile
 *     is awarded once no matter how many seats it held. That stops an empty
 *     room, a second cookie parked on the grid, and one cookie in many seats.
 *     It does not stop someone genuinely driving two cars at once (§7).
 */
const RTMaps = require('./public/maps.js');
const { MAX_RACES } = require('./store.js');
// Shared with the simulation. The floor is only safe because it assumes a car
// boosting the entire way, which no real run can do.
const { BOOST_SPEED } = require('./constants.js');

const CANON_LAPS = 3;
const RECORDS_PER_MAP = 10;

function mapById(mapId) {
  return RTMaps.MAPS.find((m) => m.id === mapId) || RTMaps.MAPS[0];
}

function createLeaderboard(store, profiles) {
  function minPlausibleMs(mapId, laps) {
    return (mapById(mapId).path.total * laps) / BOOST_SPEED * 1000;
  }

  function upsertRecord(mapId, pid, name, timeMs, at) {
    const key = String(mapId);
    const list = store.data.records[key] || (store.data.records[key] = []);
    const existing = list.find((r) => r.pid === pid);
    if (existing) {
      if (timeMs >= existing.timeMs) return false;
      existing.timeMs = timeMs;
      existing.name = name;
      existing.at = at;
    } else {
      list.push({ pid, name, timeMs, at });
    }
    list.sort((a, b) => a.timeMs - b.timeMs);
    if (list.length > RECORDS_PER_MAP) list.length = RECORDS_PER_MAP;
    return true;
  }

  function recordRace({ mapId, laps, entries, at = Date.now() }) {
    // A pid with no profile behind it cannot earn anything, and must not count
    // toward the 2-driver threshold either.
    const valid = (entries || []).filter((e) => e && profiles.get(e.pid));

    // One profile earns one set of stats, however many seats it held. Awards go
    // to its BEST finish: pos is time order for finishers, so best-pos is also
    // best-time and track records are unaffected. `progressed` is OR-ed across
    // the seats — a profile that drove anywhere raced.
    const byPid = new Map();
    for (const e of valid) {
      // Absent means "assume it raced": only the server sets this field, and an
      // older caller that omits it must keep counting as it always did.
      const progressed = e.progressed !== false;
      const prev = byPid.get(e.pid);
      if (!prev) {
        byPid.set(e.pid, Object.assign({}, e, { progressed }));
      } else if (e.pos < prev.pos) {
        byPid.set(e.pid, Object.assign({}, e, { progressed: prev.progressed || progressed }));
      } else {
        prev.progressed = prev.progressed || progressed;
      }
    }
    const awards = [...byPid.values()];

    // Only profiles that actually drove open the standings gate. A parked
    // second profile must not turn a solo run into a competitive race.
    const distinct = new Set(awards.filter((e) => e.progressed).map((e) => e.pid));
    const forStandings = distinct.size >= 2;
    const canRecord = laps === CANON_LAPS;
    const floor = minPlausibleMs(mapId, laps);
    const improved = [];

    for (const e of awards) {
      const p = profiles.get(e.pid);
      const trueFinish = !!e.finished && !e.retired;

      if (forStandings) {
        p.races += 1;                                  // retiring still counts
        if (trueFinish) {
          if (e.pos === 1) p.wins += 1;
          if (e.pos <= 3) p.podiums += 1;
        }
      }

      if (canRecord && trueFinish && typeof e.timeMs === 'number' && e.timeMs >= floor) {
        if (upsertRecord(mapId, e.pid, p.name, e.timeMs, at)) improved.push(e.pid);
      }
    }

    store.data.races.push({
      at, mapId, laps,
      players: valid.map((e) => ({
        pid: e.pid, name: e.name, pos: e.pos,
        timeMs: e.timeMs, finished: !!e.finished && !e.retired,
      })),
    });
    if (store.data.races.length > MAX_RACES) {
      store.data.races = store.data.races.slice(-MAX_RACES);
    }

    store.save();
    return { standings: forStandings, records: improved };
  }

  function view() {
    // Best time per profile per map, so standings can show a personal best
    // without the client having to join the two tables itself.
    const bestByPid = {};
    for (const [key, list] of Object.entries(store.data.records)) {
      for (const r of list) {
        (bestByPid[r.pid] || (bestByPid[r.pid] = {}))[key] = r.timeMs;
      }
    }

    const standings = Object.entries(store.data.profiles)
      .filter(([, p]) => p.name && p.races > 0)
      .map(([pid, p]) => ({
        name: p.name,
        races: p.races,
        wins: p.wins,
        podiums: p.podiums,
        bestByMap: bestByPid[pid] || {},
      }))
      .sort((a, b) => (b.wins - a.wins) || (b.podiums - a.podiums) || (a.races - b.races));

    const records = {};
    for (const [key, list] of Object.entries(store.data.records)) {
      // pid is deliberately dropped — it is a bearer-ish identifier.
      records[key] = list.map((r) => ({ name: r.name, timeMs: r.timeMs, at: r.at }));
    }

    return { standings, records };
  }

  return { recordRace, view, minPlausibleMs };
}

module.exports = { createLeaderboard, CANON_LAPS, RECORDS_PER_MAP };
