FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY services/codeops-session-gateway/package.json services/codeops-session-gateway/package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json /tsconfig.json
COPY services/codeops-session-gateway/tsconfig.json services/codeops-session-gateway/tsconfig.build.json ./
COPY services/codeops-session-gateway/src ./src
RUN npm run build \
  && npm prune --omit=dev \
  && test -f dist/index.js

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/dist ./dist
ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
