# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
ENV PATH="/root/.nub/bin:${PATH}"
WORKDIR /repo
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl g++ make python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://nubjs.com/install.sh | bash -s -- 0.1.11
COPY package.json lock.yaml .npmrc ./
COPY packages/codeops-contracts/package.json ./packages/codeops-contracts/package.json
COPY services/codeops-agent/package.json ./services/codeops-agent/package.json
COPY services/codeops-control-gateway/package.json ./services/codeops-control-gateway/package.json
COPY services/codeops-model-proxy/package.json ./services/codeops-model-proxy/package.json
COPY services/codeops-orchestrator/package.json ./services/codeops-orchestrator/package.json
COPY services/codeops-plane-controller/package.json ./services/codeops-plane-controller/package.json
COPY services/codeops-session-gateway/package.json ./services/codeops-session-gateway/package.json
COPY services/codeops-session-runtime-worker/package.json ./services/codeops-session-runtime-worker/package.json
COPY sites/agents-ui/package.json ./sites/agents-ui/package.json
RUN --mount=type=cache,target=/repo/.nub-store,sharing=locked \
  --mount=type=cache,target=/root/.cache/nub,sharing=locked \
  nub install --frozen-lockfile
COPY tsconfig.json ./tsconfig.json
COPY packages/codeops-contracts/tsconfig.json packages/codeops-contracts/tsconfig.build.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/src ./packages/codeops-contracts/src
COPY sites/agents-ui/tsconfig.json sites/agents-ui/vite.config.ts ./sites/agents-ui/
COPY sites/agents-ui/src ./sites/agents-ui/src
RUN nub run --filter @renoconcierge/codeops-contracts build \
  && nub run --filter @renoconcierge/agents-ui build \
  && nub run --filter @renoconcierge/agents-ui typecheck \
  && test -f sites/agents-ui/.output/server/index.mjs \
  && mkdir -p /deploy/node_modules \
  && cp -a node_modules/.nub /deploy/node_modules/.nub \
  && find sites/agents-ui/node_modules -mindepth 1 -maxdepth 2 -type l | while IFS= read -r link; do \
    rel="${link#sites/agents-ui/node_modules/}"; \
    target="$(readlink -f "$link")"; \
    store_rel="${target#*/node_modules/.nub/}"; \
    mkdir -p "/deploy/node_modules/$(dirname "$rel")"; \
    ln -s "/app/node_modules/.nub/$store_rel" "/deploy/node_modules/$rel"; \
  done

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/sites/agents-ui/.output ./.output
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
