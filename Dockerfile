FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    RECORDS_FILE=/app/data/records.json \
    RTR_STORE_PATH=/app/data/store.json

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

# Driver profiles (with the cookie-signing secret) and hall-of-fame records
# live here; mount a volume to keep them across deploys.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/records >/dev/null || exit 1

CMD ["node", "server.js"]
