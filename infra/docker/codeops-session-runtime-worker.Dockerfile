FROM node:24-bookworm-slim AS build
WORKDIR /repo

COPY tsconfig.json ./tsconfig.json
COPY packages/codeops-contracts/package.json packages/codeops-contracts/package-lock.json ./packages/codeops-contracts/
RUN npm ci --ignore-scripts --omit=dev --prefix packages/codeops-contracts
COPY packages/codeops-contracts/tsconfig.json packages/codeops-contracts/tsconfig.build.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/src ./packages/codeops-contracts/src

COPY services/codeops-session-runtime-worker/package.json services/codeops-session-runtime-worker/package-lock.json ./services/codeops-session-runtime-worker/
COPY infra/scripts/rewrite-workspace-dependency-for-npm.mjs ./infra/scripts/
RUN node infra/scripts/rewrite-workspace-dependency-for-npm.mjs services/codeops-session-runtime-worker/package.json \
  && npm ci --ignore-scripts --prefix services/codeops-session-runtime-worker \
  && ln -s services/codeops-session-runtime-worker/node_modules node_modules
COPY services/codeops-session-runtime-worker/tsconfig.json services/codeops-session-runtime-worker/tsconfig.build.json ./services/codeops-session-runtime-worker/
COPY services/codeops-session-runtime-worker/src ./services/codeops-session-runtime-worker/src
RUN services/codeops-session-runtime-worker/node_modules/.bin/tsc -p packages/codeops-contracts/tsconfig.build.json \
  && npm run build --prefix services/codeops-session-runtime-worker \
  && npm prune --omit=dev --prefix services/codeops-session-runtime-worker \
  && test -f services/codeops-session-runtime-worker/dist/runtime-main.js \
  && rm services/codeops-session-runtime-worker/node_modules/@codeops/codeops-contracts \
  && mkdir services/codeops-session-runtime-worker/node_modules/@codeops/codeops-contracts \
  && cp packages/codeops-contracts/package.json services/codeops-session-runtime-worker/node_modules/@codeops/codeops-contracts/ \
  && cp -R packages/codeops-contracts/dist services/codeops-session-runtime-worker/node_modules/@codeops/codeops-contracts/ \
  && cp -R packages/codeops-contracts/node_modules services/codeops-session-runtime-worker/node_modules/@codeops/codeops-contracts/

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/anulman/codeops" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/codeops/
COPY --from=build --chown=node:node /repo/services/codeops-session-runtime-worker ./services/codeops-session-runtime-worker
ENV NODE_ENV=production
USER node
CMD ["node", "services/codeops-session-runtime-worker/dist/runtime-main.js"]
