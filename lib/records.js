'use strict';
/* Persistent Hall of Fame: per-track lap/race records and all-time driver
 * stats, stored as a small JSON file. Humans only — bots never appear.
 *
 * Everything is keyed by profile id (see lib/profiles.js), not by the name on
 * screen: a driver keeps their history when they rename, and claiming a name
 * someone gave up does not hand over their wins.
 *
 * Two deliberate asymmetries:
 *   - Track records count solo runs. A fast time is fast whether or not
 *     anyone else was on track.
 *   - All-time standings need 2+ distinct profiles that actually RACED, and
 *     each profile is awarded once per race. That stops farming wins against
 *     AI drivers, an empty room, and a second browser parked on the grid.
 *     It does not stop someone genuinely driving two cars at once.
 */
const fs = require('fs');
const path = require('path');
const RTMaps = require('../public/maps.js');
// Shared with the simulation, so the floor below can never drift from it.
const { P } = require('./race.js');

// The fastest a car could conceivably cover `laps` of a track: boosting the
// entire way, which no real run can do. Anything quicker is a bug or an
// exploit, not a record.
function minPlausibleMs(mapId, laps) {
  const map = RTMaps.MAPS.find((m) => m.id === mapId) || RTMaps.MAPS[0];
  return ((map.path.total * laps) / P.BOOST_MAX) * 1000;
}

class Records {
  constructor(file) {
    this.file = file;
    this.data = { tracks: {}, drivers: {} };
    this.timer = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.tracks && parsed.drivers) this.data = parsed;
    } catch (err) {
      // first run, or unreadable file: start empty
    }
  }

  _save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.error('[records] could not save:', err.message);
      }
    }, 400);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Fold one finished race into the records. Every field must come from the
   * simulation, never from a client.
   * rows: [{ pid, name, carId, bot, pos, finished, out, time, bestLap, points, progressed }]
   * isProfile(pid): optional check that a real profile stands behind the id.
   * Returns { standings, records }:
   *   standings  whether the race counted toward all-time driver stats
   *   records    the records that were broken: [{ type: 'lap'|'race', name, time, prev }]
   */
  submit({ mapId, laps, mode }, rows, isProfile = () => true) {
    const broken = [];
    const track = this.data.tracks[mapId] || (this.data.tracks[mapId] = {});
    const today = new Date().toISOString().slice(0, 10);

    // One profile earns one set of stats, however many seats it somehow held.
    // Awards go to its BEST finish; `progressed` is OR-ed across the seats —
    // a profile that drove anywhere raced. Bots have no profile and are out;
    // so is a pid with no profile behind it, which can earn nothing and must
    // not count toward the two-driver threshold either.
    const byPid = new Map();
    for (const r of rows || []) {
      if (!r || r.bot || !r.pid || !isProfile(r.pid)) continue;
      // Absent means "assume it raced": only the server sets this field.
      const progressed = r.progressed !== false;
      const prev = byPid.get(r.pid);
      if (!prev) byPid.set(r.pid, { ...r, progressed });
      else if (r.pos < prev.pos) byPid.set(r.pid, { ...r, progressed: prev.progressed || progressed });
      else prev.progressed = prev.progressed || progressed;
    }
    const awards = [...byPid.values()];

    // Only profiles that actually drove open the standings gate. A parked
    // second profile must not turn a solo run into a competitive race.
    const forStandings = awards.filter((r) => r.progressed).length >= 2;
    const lapFloor = minPlausibleMs(mapId, 1);
    const raceFloor = minPlausibleMs(mapId, laps);

    for (const r of awards) {
      const retired = r.out === 'retired';
      // In elimination only the survivor "finishes"; everyone else is placed
      // by when they were knocked out, and those placings are earned.
      const placed = !retired && (mode === 'elimination' || !!r.finished);

      if (forStandings) {
        const d = Object.prototype.hasOwnProperty.call(this.data.drivers, r.pid)
          ? this.data.drivers[r.pid]
          : (this.data.drivers[r.pid] = { name: r.name, races: 0, wins: 0, podiums: 0, points: 0 });
        d.name = r.name;
        d.races++;                          // retiring still counts as a race
        d.points += r.points || 0;
        if (placed) {
          if (r.pos === 1) d.wins++;
          if (r.pos <= 3) d.podiums++;
        }
      }

      if (typeof r.bestLap === 'number' && r.bestLap >= lapFloor && (!track.lap || r.bestLap < track.lap.time)) {
        broken.push({ type: 'lap', name: r.name, time: r.bestLap, prev: track.lap ? track.lap.time : null });
        track.lap = { pid: r.pid, name: r.name, time: r.bestLap, carId: r.carId, date: today };
      }
      if (mode === 'race' && r.finished && !retired && typeof r.time === 'number' && r.time >= raceFloor) {
        const rk = 'race' + laps;
        if (!track[rk] || r.time < track[rk].time) {
          broken.push({ type: 'race', name: r.name, time: r.time, laps, prev: track[rk] ? track[rk].time : null });
          track[rk] = { pid: r.pid, name: r.name, time: r.time, carId: r.carId, date: today };
        }
      }
    }
    this._save();
    return { standings: forStandings, records: broken };
  }

  /**
   * nameOf(pid) resolves a profile's current name:
   *   a string  the name it holds now
   *   ''        the profile exists but holds no name (it was released)
   *   null      unknown profile — fall back to the name recorded at the time
   * A driver with no current name is left off the board rather than shown
   * under a name that may by now belong to someone else. Profile ids stay private.
   */
  summary(nameOf = () => null) {
    const current = (pid, recorded) => {
      const n = nameOf(pid);
      return n === null || n === undefined ? recorded : n;
    };
    const drivers = Object.entries(this.data.drivers)
      .map(([pid, d]) => ({ name: current(pid, d.name), races: d.races, wins: d.wins, podiums: d.podiums, points: d.points }))
      .filter((d) => d.name && d.races > 0)
      .sort((a, b) => b.wins - a.wins || b.podiums - a.podiums || b.points - a.points || a.races - b.races)
      .slice(0, 10);
    const tracks = {};
    for (const [mapId, t] of Object.entries(this.data.tracks)) {
      const lap = t.lap
        ? { name: current(t.lap.pid, t.lap.name) || '(name released)', time: t.lap.time, carId: t.lap.carId, date: t.lap.date }
        : null;
      tracks[mapId] = { lap };
    }
    return { drivers, tracks };
  }
}

module.exports = { Records, minPlausibleMs };
