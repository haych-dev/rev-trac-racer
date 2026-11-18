#!/usr/bin/env bash
# Deploy the committed HEAD to the Hostinger VPS.
#   DEPLOY_KEY=~/.ssh/<key> ./deploy.sh
# DEPLOY_KEY is an SSH private key the VPS accepts for DEPLOY_HOST.
# Ships `git archive HEAD` (so uncommitted work never goes out), rebuilds the
# image on the box and restarts the container. Players mid-race are dropped,
# so pick a quiet moment. The hall of fame is in a Docker volume and survives.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@145.79.11.91}"
KEY="${DEPLOY_KEY:?set DEPLOY_KEY to an SSH private key the VPS accepts, e.g. DEPLOY_KEY=~/.ssh/<key> ./deploy.sh}"
DIR=/docker/rev-trac-racer
URL=https://racer.srv1964127.hstgr.cloud
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes "$HOST")

cd "$(dirname "$0")"
if [ -n "$(git status --porcelain)" ]; then
  echo "warning: uncommitted changes are NOT deployed (shipping $(git rev-parse --short HEAD))" >&2
fi

echo "==> shipping $(git rev-parse --short HEAD) to $HOST:$DIR"
# Replace the source tree wholesale so deleted files do not linger in the
# build context. Data is in a named volume, not in this directory.
git archive --format=tar HEAD | "${SSH[@]}" "set -e; rm -rf $DIR.new; mkdir -p $DIR.new; tar -x -C $DIR.new; rm -rf $DIR.old; if [ -d $DIR ]; then mv $DIR $DIR.old; fi; mv $DIR.new $DIR; rm -rf $DIR.old"

echo "==> building and restarting"
"${SSH[@]}" "cd $DIR && docker compose -f docker-compose.vps.yml up -d --build"

echo "==> waiting for $URL"
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "$URL/api/records"; then
    echo "live: $URL"
    exit 0
  fi
  sleep 2
done
echo "deployed, but $URL did not answer within 60s — check: ssh -i $KEY $HOST 'docker compose -p rev-trac-racer logs --tail 50'" >&2
exit 1
