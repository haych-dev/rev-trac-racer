/* Rev-Trac Racer — shared game vocabulary: powerups, chaos events, status
 * flags, scoring, awards. Server uses the keys; client uses the copy. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RTItems = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ITEMS = {
    boost:   { name: 'Chevron Boost',       icon: '❯❯❯', color: '#ef4d57', desc: 'Warp speed for two seconds — even across the grass.' },
    cab:     { name: 'CAB Meeting',         icon: '📋',  color: '#c07c00', desc: 'Drop it behind you. Whoever hits it is stuck in review.' },
    lock:    { name: 'Transport Lock',      icon: '🔒',  color: '#2d6fd6', desc: 'Locks the car ahead in place.' },
    shield:  { name: 'Emergency Change',    icon: '⚡',  color: '#d4a400', desc: 'Six seconds of total immunity. Skip the red tape.' },
    oops:    { name: 'OOPS!',               icon: '💥',  color: '#d6336c', desc: 'Everyone ahead of you spins out.' },
    missile: { name: 'Rollback Rocket',     icon: '🚀',  color: '#e8590c', desc: 'Homing rocket that hunts the car ahead.' },
    swap:    { name: 'Retrofit',            icon: '🔄',  color: '#0c8599', desc: 'Swap places with the car ahead.' },
    freeze:  { name: 'Change Freeze',       icon: '🧊',  color: '#1c7ed6', desc: 'Everyone else drives on ice.' },
    bug:     { name: 'Regression Bug',      icon: '🐛',  color: '#5f8f00', desc: "Inverts everyone else's steering." },
    ink:     { name: 'Undocumented Change', icon: '🖋️', color: '#343a40', desc: 'Splatters ink across rival screens.' },
    giant:   { name: 'Mass Transport',      icon: '🚛',  color: '#7048e8', desc: 'Grow huge and flatten anything you touch.' },
    auto:    { name: 'Automation',          icon: '🤖',  color: '#1e396b', desc: 'Four seconds of flawless autopilot at full boost.' },
  };
  const ITEM_KEYS = Object.keys(ITEMS);

  const CHAOS = {
    freeze:     { title: 'CHANGE FREEZE',     sub: 'The whole track is ice!',          icon: '🧊' },
    turbo:      { title: 'HYPERCARE',         sub: 'Everything is faster!',            icon: '⏩' },
    cabstorm:   { title: 'CAB IN SESSION',    sub: 'Meetings everywhere!',             icon: '📋' },
    outage:     { title: 'PROD OUTAGE',       sub: 'Who turned off the lights?',       icon: '🔦' },
    itemrain:   { title: 'GO-LIVE BONUS',     sub: 'Powerups for everyone!',           icon: '🎁' },
    regression: { title: 'REGRESSION',        sub: 'Steering is inverted!',            icon: '🐛' },
    emergency:  { title: 'EMERGENCY RELEASE', sub: 'Everybody boost!',                 icon: '🚨' },
    audit:      { title: 'SURPRISE AUDIT',    sub: 'First place is under review!',     icon: '🔍' },
  };

  // Per-player status bits sent in every snapshot.
  const FLAGS = {
    BOOST: 1, SPIN: 2, LOCKED: 4, SHIELD: 8, GIANT: 16, AUTO: 32, ICY: 64, BUG: 128,
    INK: 256, DRIFT: 512, FINISHED: 1024, OUT: 2048, WRONG: 4096, OFF: 8192, SLIP: 16384, OIL: 32768,
  };

  const POINTS = [15, 12, 10, 8, 6, 5, 4, 3];
  const FASTEST_LAP_BONUS = 1;

  const AWARDS = {
    fastestLap: { title: 'Fastest Lap',     icon: '⏱️' },
    wrecker:    { title: 'Release Wrecker', icon: '🔨' },
    magnet:     { title: 'CAB Magnet',      icon: '🧲' },
    drift:      { title: 'Drift King',      icon: '🌀' },
    items:      { title: 'Change Champion', icon: '🎒' },
    speed:      { title: 'Speed Demon',     icon: '🔥' },
  };

  return { ITEMS, ITEM_KEYS, CHAOS, FLAGS, POINTS, FASTEST_LAP_BONUS, AWARDS };
});
