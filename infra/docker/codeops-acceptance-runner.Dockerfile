# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.61.1-noble
LABEL org.opencontainers.image.source="https://github.com/anulman/codeops" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/codeops/
COPY services/codeops-acceptance-runner/package.json services/codeops-acceptance-runner/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY services/codeops-acceptance-runner/src ./src
USER pwuser
ENTRYPOINT ["node", "src/agents-ui-smoke.mjs"]
