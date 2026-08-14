FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/anulman/codeops" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /opt/codeops-agent
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/codeops/
COPY services/codeops-agent/package.json services/codeops-agent/package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git socat \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --omit=dev --ignore-scripts

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
