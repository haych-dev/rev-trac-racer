/* Rev-Trac Racer — shared car roster (used by server and client). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RTCars = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // body: top-down silhouette drawn by the client renderer
  //   formula  – open-wheeler with wings
  //   muscle   – wide coupe, hood scoop, spoiler
  //   van      – boxy hauler
  //   kart     – tiny open kart, exposed driver
  //   ute      – pickup with an open bed
  //   roadster – sleek open-top teardrop
  //   beetle   – round bubble car
  //   wedge    – angular supercar
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
  return { CARS };
});
