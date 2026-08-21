# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
ENV PATH="/root/.nub/bin:${PATH}"
WORKDIR /repo
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl g++ make python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl --fail --silent --show-error --location --retry 5 --retry-all-errors \
       --output /tmp/nub.tar.gz \
       https://github.com/nubjs/nub/releases/download/v0.1.11/nub-linux-x64.tar.gz \
  && echo "d227290e3a45c05ff20508a961f01950c50a138b08caf76d59f403e8a721330d  /tmp/nub.tar.gz" \
       | sha256sum --check --strict \
  && tar -xzf /tmp/nub.tar.gz -C /tmp \
  && install -m 0555 /tmp/bin/nub /usr/local/bin/nub \
  && ln -s nub /usr/local/bin/nubx \
  && nub --version \
  && rm -rf /tmp/nub.tar.gz /tmp/bin /tmp/runtime
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
COPY sites/agents-ui/tsconfig.json sites/agents-ui/vite.config.ts sites/agents-ui/postcss.config.mjs ./sites/agents-ui/
COPY sites/agents-ui/src ./sites/agents-ui/src
COPY sites/agents-ui/public ./sites/agents-ui/public
RUN nub run --filter @codeops/codeops-contracts build \
  && nub run --filter @codeops/agents-ui build \
  && nub run --filter @codeops/agents-ui typecheck \
  && test -f sites/agents-ui/.output/server/index.mjs \
  && test -f sites/agents-ui/.output/public/manifest.webmanifest \
  && test -f sites/agents-ui/.output/public/session-notifications-sw.js

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/anulman/codeops" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/codeops/
COPY --from=build --chown=node:node /repo/sites/agents-ui/.output ./.output
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
