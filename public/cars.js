/* Rev-Trac Racer — shared car roster and body stats (server and client). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RTCars = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Each body is a top-down silhouette (drawn by the client) with its own
  // handling. Multipliers are deliberately modest: every body can win.
  //   speed    top speed          accel   acceleration
  //   handling grip + turn rate   weight  who wins a shunt
  //   offroad  speed kept on the grass
  const BODIES = {
    formula:  { label: 'Open-wheeler', speed: 1.05, accel: 1.00, handling: 1.08, weight: 0.85, offroad: 0.80 },
    muscle:   { label: 'Muscle car',   speed: 1.03, accel: 1.07, handling: 0.95, weight: 1.15, offroad: 1.00 },
    van:      { label: 'Hauler van',   speed: 0.97, accel: 0.94, handling: 0.94, weight: 1.60, offroad: 1.10 },
    kart:     { label: 'Kart',         speed: 0.95, accel: 1.16, handling: 1.14, weight: 0.70, offroad: 0.90 },
    ute:      { label: 'Ute',          speed: 0.98, accel: 0.99, handling: 0.97, weight: 1.35, offroad: 1.50 },
    roadster: { label: 'Roadster',     speed: 1.02, accel: 1.04, handling: 1.03, weight: 0.95, offroad: 0.90 },
    beetle:   { label: 'Bubble car',   speed: 0.97, accel: 1.06, handling: 1.11, weight: 0.90, offroad: 1.20 },
    wedge:    { label: 'Supercar',     speed: 1.07, accel: 0.97, handling: 0.98, weight: 1.00, offroad: 0.80 },
  };

  const CARS = [
    { id: 0,  name: 'Prod Express',      color: '#e63946', body: 'muscle' },
    { id: 1,  name: 'Dev Demon',         color: '#9d4edd', body: 'wedge' },
    { id: 2,  name: 'QA Quattro',        color: '#2a9d8f', body: 'formula' },
    { id: 3,  name: 'Sandbox Speedster', color: '#f4832b', body: 'roadster' },
    { id: 4,  name: 'Transport Titan',   color: '#3a86ff', body: 'van' },
    { id: 5,  name: 'Hotfix Hurricane',  color: '#ffd60a', body: 'formula' },
    { id: 6,  name: 'Release Rocket',    color: '#57cc3f', body: 'wedge' },
    { id: 7,  name: 'Go-Live GT',        color: '#ff5da2', body: 'muscle' },
    { id: 8,  name: 'Basis Bandit',      color: '#8d99ae', body: 'kart' },
    { id: 9,  name: 'Kernel Krusher',    color: '#9b2226', body: 'ute' },
    { id: 10, name: 'Migration Machine', color: '#00e5ff', body: 'roadster' },
    { id: 11, name: 'Rollback Racer',    color: '#1e396b', body: 'van' },
    { id: 12, name: 'Patch Panther',     color: '#9ef01a', body: 'kart' },
    { id: 13, name: 'Cutover Comet',     color: '#f1f3f5', body: 'beetle' },
    { id: 14, name: 'Audit Avenger',     color: '#b08968', body: 'ute' },
    { id: 15, name: 'Retrofit Renegade', color: '#06d6a0', body: 'beetle' },
  ];

  function statsFor(car) {
    return BODIES[car && car.body] || BODIES.wedge;
  }

  return { CARS, BODIES, statsFor };
});
