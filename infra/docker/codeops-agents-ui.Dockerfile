# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
ENV PATH="/root/.nub/bin:${PATH}"
WORKDIR /repo
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl g++ make python3 \
  && rm -rf /var/lib/apt/lists/* \
  && for attempt in 1 2 3 4 5; do \
       curl --fail --silent --show-error --location --retry 5 --retry-all-errors https://nubjs.com/install.sh \
         | bash -s -- 0.1.11 && break; \
       [ "$attempt" = 5 ] && exit 1; \
       sleep $((attempt * 2)); \
     done
COPY package.json lock.yaml .npmrc ./
COPY packages/codeops-contracts/package.json ./packages/codeops-contracts/package.json
COPY services/codeops-acceptance-runner/package.json ./services/codeops-acceptance-runner/package.json
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
RUN nub run --filter @codeops/codeops-contracts build \
  && nub run --filter @codeops/agents-ui build \
  && nub run --filter @codeops/agents-ui typecheck \
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
LABEL org.opencontainers.image.source="https://github.com/anulman/codeops" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/codeops/
COPY --from=build --chown=node:node /deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/sites/agents-ui/.output ./.output
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
