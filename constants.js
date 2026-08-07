/**
 * Physics values shared by the simulation (server.js) and the leaderboard's
 * plausibility floor (leaderboard.js).
 *
 * These live here rather than in server.js because requiring server.js starts
 * an HTTP listener as a side effect, so nothing else can import from it.
 */
module.exports = {
  // Top speed while a Chevron Boost is active. The leaderboard's minimum
  // plausible race time assumes a car holding this the whole way — which no
  // real run can do, making the floor safe against false rejections.
  BOOST_SPEED: 660,
};
