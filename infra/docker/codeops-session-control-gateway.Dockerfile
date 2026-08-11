FROM node:24-bookworm-slim AS build
WORKDIR /repo

COPY tsconfig.json ./tsconfig.json
COPY packages/codeops-contracts/package.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/tsconfig.json packages/codeops-contracts/tsconfig.build.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/src ./packages/codeops-contracts/src

COPY services/codeops-control-gateway/package.json services/codeops-control-gateway/package-lock.json ./services/codeops-control-gateway/
COPY infra/scripts/rewrite-workspace-dependency-for-npm.mjs ./infra/scripts/
RUN node infra/scripts/rewrite-workspace-dependency-for-npm.mjs services/codeops-control-gateway/package.json \
  && npm ci --ignore-scripts --prefix services/codeops-control-gateway \
  && ln -s services/codeops-control-gateway/node_modules node_modules
COPY services/codeops-control-gateway/tsconfig.json services/codeops-control-gateway/tsconfig.build.json ./services/codeops-control-gateway/
COPY services/codeops-control-gateway/src ./services/codeops-control-gateway/src
COPY services/codeops-control-gateway/sql ./services/codeops-control-gateway/sql
RUN services/codeops-control-gateway/node_modules/.bin/tsc -p packages/codeops-contracts/tsconfig.build.json \
  && npm run build --prefix services/codeops-control-gateway \
  && npm prune --omit=dev --prefix services/codeops-control-gateway \
  && test -f services/codeops-control-gateway/dist/session-control-main.js \
  && test -f services/codeops-control-gateway/dist/session-migrate-main.js \
  && rm services/codeops-control-gateway/node_modules/@codeops/codeops-contracts \
  && mkdir services/codeops-control-gateway/node_modules/@codeops/codeops-contracts \
  && cp packages/codeops-contracts/package.json services/codeops-control-gateway/node_modules/@codeops/codeops-contracts/ \
  && cp -R packages/codeops-contracts/dist services/codeops-control-gateway/node_modules/@codeops/codeops-contracts/

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/anulman/codeops" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/codeops/
COPY --from=build --chown=node:node /repo/services/codeops-control-gateway ./services/codeops-control-gateway
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "services/codeops-control-gateway/dist/session-control-main.js"]
