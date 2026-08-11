FROM node:24-bookworm-slim AS build
WORKDIR /repo

COPY tsconfig.json ./tsconfig.json
COPY packages/codeops-contracts/package.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/tsconfig.json packages/codeops-contracts/tsconfig.build.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/src ./packages/codeops-contracts/src

COPY services/codeops-orchestrator/package.json services/codeops-orchestrator/package-lock.json ./services/codeops-orchestrator/
COPY infra/scripts/rewrite-workspace-dependency-for-npm.mjs ./infra/scripts/
RUN node infra/scripts/rewrite-workspace-dependency-for-npm.mjs services/codeops-orchestrator/package.json \
  && npm ci --ignore-scripts --prefix services/codeops-orchestrator \
  && ln -s services/codeops-orchestrator/node_modules node_modules
COPY services/codeops-orchestrator/tsconfig.json services/codeops-orchestrator/tsconfig.build.json ./services/codeops-orchestrator/
COPY services/codeops-orchestrator/src ./services/codeops-orchestrator/src
RUN services/codeops-orchestrator/node_modules/.bin/tsc -p packages/codeops-contracts/tsconfig.build.json \
  && npm run build --prefix services/codeops-orchestrator \
  && npm prune --omit=dev --prefix services/codeops-orchestrator \
  && test -f services/codeops-orchestrator/dist/worker.js \
  && test -f services/codeops-orchestrator/dist/workflow.js \
  && rm services/codeops-orchestrator/node_modules/@codeops/codeops-contracts \
  && mkdir services/codeops-orchestrator/node_modules/@codeops/codeops-contracts \
  && cp packages/codeops-contracts/package.json services/codeops-orchestrator/node_modules/@codeops/codeops-contracts/ \
  && cp -R packages/codeops-contracts/dist services/codeops-orchestrator/node_modules/@codeops/codeops-contracts/

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /repo/services/codeops-orchestrator ./services/codeops-orchestrator
ENV NODE_ENV=production
USER node
CMD ["node", "services/codeops-orchestrator/dist/worker.js"]
