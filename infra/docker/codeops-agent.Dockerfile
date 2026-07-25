FROM node:24-bookworm-slim

WORKDIR /opt/codeops-agent
COPY services/codeops-agent/package.json services/codeops-agent/package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git socat \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --omit=dev --ignore-scripts

COPY services/codeops-agent/entrypoint.sh /usr/local/bin/codeops-agent-entrypoint
RUN chmod 0555 /usr/local/bin/codeops-agent-entrypoint \
  && test -x node_modules/.bin/codex-acp \
  && node_modules/.bin/codex-acp --version

ENV NODE_ENV=production \
    NO_BROWSER=1 \
    INITIAL_AGENT_MODE=agent
USER node
WORKDIR /workspace
ENTRYPOINT ["codeops-agent-entrypoint"]
