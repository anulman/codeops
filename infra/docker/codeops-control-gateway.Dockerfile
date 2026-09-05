ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /repo

COPY tsconfig.json ./tsconfig.json
COPY packages/codeops-contracts/package.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/tsconfig.json packages/codeops-contracts/tsconfig.build.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/src ./packages/codeops-contracts/src

COPY services/codeops-control-gateway/package.json services/codeops-control-gateway/package-lock.json ./services/codeops-control-gateway/
COPY infra/scripts/rewrite-workspace-dependency-for-npm.mjs ./infra/scripts/
RUN --network=none node infra/scripts/rewrite-workspace-dependency-for-npm.mjs services/codeops-control-gateway/package.json
RUN npm ci --ignore-scripts --prefix services/codeops-control-gateway \
  && ln -s services/codeops-control-gateway/node_modules node_modules
COPY services/codeops-control-gateway/tsconfig.json services/codeops-control-gateway/tsconfig.build.json ./services/codeops-control-gateway/
COPY services/codeops-control-gateway/src ./services/codeops-control-gateway/src
COPY services/codeops-control-gateway/sql ./services/codeops-control-gateway/sql
RUN --network=none services/codeops-control-gateway/node_modules/.bin/tsc -p packages/codeops-contracts/tsconfig.build.json \
  && npm run build --prefix services/codeops-control-gateway \
  && npm prune --offline --ignore-scripts --omit=dev --prefix services/codeops-control-gateway \
  && test -f services/codeops-control-gateway/dist/runtime-main.js \
  && test -f services/codeops-control-gateway/dist/proof-publisher-main.js \
  && rm services/codeops-control-gateway/node_modules/@codeops/codeops-contracts \
  && mkdir services/codeops-control-gateway/node_modules/@codeops/codeops-contracts \
  && cp packages/codeops-contracts/package.json services/codeops-control-gateway/node_modules/@codeops/codeops-contracts/ \
  && cp -R packages/codeops-contracts/dist services/codeops-control-gateway/node_modules/@codeops/codeops-contracts/

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/anulman/codeops" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/codeops/
COPY --from=build --chown=node:node /repo/services/codeops-control-gateway ./services/codeops-control-gateway
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "services/codeops-control-gateway/dist/runtime-main.js"]
