FROM node:22-alpine

WORKDIR /app

# Manifests first so the dependency layer stays cached until they change.
COPY package.json package-lock.json ./
# devDependencies are only socket.io-client, used by test/bots.js — not needed
# to serve the game.
RUN npm ci --omit=dev

COPY . .

# server.js reads PORT (defaults to 3000); keep this aligned with the published
# port in docker-compose.yml.
ENV PORT=3005
EXPOSE 3005

CMD ["node", "server.js"]
