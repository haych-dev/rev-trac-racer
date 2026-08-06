/* Rev-Trac Racer — shared car roster (used by server and client). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RTCars = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CARS = [
    { id: 0,  name: 'Prod Express',      color: '#e63946' },
    { id: 1,  name: 'Dev Demon',         color: '#9d4edd' },
    { id: 2,  name: 'QA Quattro',        color: '#2a9d8f' },
    { id: 3,  name: 'Sandbox Speedster', color: '#f4832b' },
    { id: 4,  name: 'Transport Titan',   color: '#3a86ff' },
    { id: 5,  name: 'Hotfix Hurricane',  color: '#ffd60a' },
    { id: 6,  name: 'Release Rocket',    color: '#57cc3f' },
    { id: 7,  name: 'Go-Live GT',        color: '#ff5da2' },
    { id: 8,  name: 'Basis Bandit',      color: '#8d99ae' },
    { id: 9,  name: 'Kernel Krusher',    color: '#9b2226' },
    { id: 10, name: 'Migration Machine', color: '#00e5ff' },
    { id: 11, name: 'Rollback Racer',    color: '#1e396b' },
    { id: 12, name: 'Patch Panther',     color: '#9ef01a' },
    { id: 13, name: 'Cutover Comet',     color: '#f1f3f5' },
    { id: 14, name: 'Audit Avenger',     color: '#b08968' },
    { id: 15, name: 'Retrofit Renegade', color: '#06d6a0' },
  ];
  return { CARS };
});
