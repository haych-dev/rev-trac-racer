/**
 * Bootstraps a driver profile over HTTP and returns a Cookie header value for
 * socket.io-client's extraHeaders. Rooms now require a claimed name, so every
 * scripted client needs one.
 *
 * Always run harnesses with RTR_STORE_PATH pointed at a throwaway file so test
 * drivers never land on the real leaderboard.
 */
async function makeProfile(url, name) {
  const res = await fetch(`${url}/api/profile/me`);
  if (!res.ok) throw new Error(`profile bootstrap failed: HTTP ${res.status}`);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('server did not set a profile cookie');

  const claim = await fetch(`${url}/api/profile/name`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name }),
  });
  if (!claim.ok) {
    const body = await claim.text();
    throw new Error(`claiming "${name}" failed: HTTP ${claim.status} ${body}`);
  }
  return cookie;
}

module.exports = { makeProfile };
