/**
 * Bootstraps a driver profile over HTTP and returns a Cookie header value for
 * socket.io-client's extraHeaders. Rooms require a claimed name, so every
 * scripted client needs one.
 *
 * Always run against a server whose RTR_STORE_PATH and RECORDS_FILE point at
 * throwaway files so test drivers never land in a real hall of fame.
 */
async function mintProfile(url) {
  const res = await fetch(`${url}/api/profile/me`);
  if (!res.ok) throw new Error(`profile bootstrap failed: HTTP ${res.status}`);
  const raw = res.headers.get('set-cookie') || '';
  const cookie = raw.split(';')[0];
  if (!cookie) throw new Error('server did not set a profile cookie');
  return { cookie, raw, body: await res.json() };
}

async function claimName(url, cookie, name) {
  const res = await fetch(`${url}/api/profile/name`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function makeProfile(url, name) {
  const { cookie } = await mintProfile(url);
  const claim = await claimName(url, cookie, name);
  if (claim.status !== 200) throw new Error(`claiming "${name}" failed: HTTP ${claim.status} ${JSON.stringify(claim.body)}`);
  return cookie;
}

module.exports = { makeProfile, mintProfile, claimName };
