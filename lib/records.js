'use strict';
/* Persistent Hall of Fame: per-track lap/race records and all-time driver
 * stats, stored as a small JSON file. Humans only — bots never appear.
 *
 * Everything is keyed by profile id (see lib/profiles.js), not by the name on
 * screen: a driver keeps their history when they rename, and claiming a name
 * someone gave up does not hand over their wins. */
const fs = require('fs');
const path = require('path');

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
   * Fold one finished race into the records.
   * rows: [{ pid, name, carId, bot, pos, finished, time, bestLap, points }]
   * Rows without a pid (bots) are ignored.
   * Returns the records that were broken: [{ type: 'lap'|'race', name, time, prev }]
   */
  submit({ mapId, laps, mode }, rows) {
    const broken = [];
    const track = this.data.tracks[mapId] || (this.data.tracks[mapId] = {});
    const today = new Date().toISOString().slice(0, 10);

    for (const r of rows) {
      if (r.bot || !r.pid) continue;
      const d = Object.prototype.hasOwnProperty.call(this.data.drivers, r.pid)
        ? this.data.drivers[r.pid]
        : (this.data.drivers[r.pid] = { name: r.name, races: 0, wins: 0, podiums: 0, points: 0 });
      d.name = r.name;
      d.races++;
      d.points += r.points || 0;
      if (r.pos === 1) d.wins++;
      if (r.pos <= 3) d.podiums++;

      if (r.bestLap && (!track.lap || r.bestLap < track.lap.time)) {
        broken.push({ type: 'lap', name: r.name, time: r.bestLap, prev: track.lap ? track.lap.time : null });
        track.lap = { pid: r.pid, name: r.name, time: r.bestLap, carId: r.carId, date: today };
      }
      if (mode === 'race' && r.finished && r.time) {
        const rk = 'race' + laps;
        if (!track[rk] || r.time < track[rk].time) {
          broken.push({ type: 'race', name: r.name, time: r.time, laps, prev: track[rk] ? track[rk].time : null });
          track[rk] = { pid: r.pid, name: r.name, time: r.time, carId: r.carId, date: today };
        }
      }
    }
    this._save();
    return broken;
  }

  /**
   * nameOf(pid) returns the driver's current name, or null if unknown; the
   * name recorded at the time is used as a fallback. Profile ids stay private.
   */
  summary(nameOf = () => null) {
    const drivers = Object.entries(this.data.drivers)
      .map(([pid, d]) => ({ name: nameOf(pid) || d.name, races: d.races, wins: d.wins, podiums: d.podiums, points: d.points }))
      .sort((a, b) => b.wins - a.wins || b.points - a.points || a.races - b.races)
      .slice(0, 10);
    const tracks = {};
    for (const [mapId, t] of Object.entries(this.data.tracks)) {
      const lap = t.lap ? { name: nameOf(t.lap.pid) || t.lap.name, time: t.lap.time, carId: t.lap.carId, date: t.lap.date } : null;
      tracks[mapId] = { lap };
    }
    return { drivers, tracks };
  }
}

module.exports = { Records };
