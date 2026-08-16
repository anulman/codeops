FROM node:24-bookworm-slim AS build
WORKDIR /repo

COPY tsconfig.json ./tsconfig.json
COPY packages/codeops-contracts/package.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/tsconfig.json packages/codeops-contracts/tsconfig.build.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/src ./packages/codeops-contracts/src

COPY services/codeops-agent/package.json services/codeops-agent/package-lock.json ./services/codeops-agent/
COPY infra/scripts/rewrite-workspace-dependency-for-npm.mjs ./infra/scripts/
RUN node infra/scripts/rewrite-workspace-dependency-for-npm.mjs services/codeops-agent/package.json \
  && npm ci --ignore-scripts --prefix services/codeops-agent \
  && ln -s services/codeops-agent/node_modules node_modules \
  && services/codeops-agent/node_modules/.bin/tsc packages/codeops-contracts/src/canonical-json.ts \
    --declaration --module NodeNext --moduleResolution NodeNext --outDir packages/codeops-contracts/dist \
    --ignoreConfig --sourceMap --strict --target ES2022 --types node \
  && npm prune --omit=dev --prefix services/codeops-agent \
  && rm services/codeops-agent/node_modules/@codeops/codeops-contracts \
  && mkdir services/codeops-agent/node_modules/@codeops/codeops-contracts \
  && cp packages/codeops-contracts/package.json services/codeops-agent/node_modules/@codeops/codeops-contracts/ \
  && cp -R packages/codeops-contracts/dist services/codeops-agent/node_modules/@codeops/codeops-contracts/

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/anulman/codeops" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /opt/codeops-agent
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/codeops/
COPY --from=build /repo/services/codeops-agent/package.json ./
COPY --from=build /repo/services/codeops-agent/package-lock.json ./
COPY --from=build /repo/services/codeops-agent/node_modules ./node_modules
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git socat \
  && rm -rf /var/lib/apt/lists/*

COPY services/codeops-agent/entrypoint.sh /usr/local/bin/codeops-agent-entrypoint
COPY services/codeops-agent/prepare-project-context.mjs /opt/codeops-agent/prepare-project-context.mjs
COPY services/codeops-agent/work-items-mcp.mjs /opt/codeops-agent/work-items-mcp.mjs
COPY services/codeops-agent/github-reads-mcp.mjs /opt/codeops-agent/github-reads-mcp.mjs
COPY services/codeops-agent/github-mutations-mcp.mjs /opt/codeops-agent/github-mutations-mcp.mjs
RUN chmod 0555 /usr/local/bin/codeops-agent-entrypoint \
  && chmod 0444 /opt/codeops-agent/prepare-project-context.mjs \
  && chmod 0444 /opt/codeops-agent/work-items-mcp.mjs \
  && chmod 0444 /opt/codeops-agent/github-reads-mcp.mjs \
  && chmod 0444 /opt/codeops-agent/github-mutations-mcp.mjs \
  && test -x node_modules/.bin/codex-acp \
  && node_modules/.bin/codex-acp --version

ENV NODE_ENV=production \
    NO_BROWSER=1 \
    INITIAL_AGENT_MODE=agent
USER node
WORKDIR /workspace
ENTRYPOINT ["codeops-agent-entrypoint"]
