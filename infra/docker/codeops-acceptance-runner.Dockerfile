# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.61.1-noble
WORKDIR /app
COPY services/codeops-acceptance-runner/package.json services/codeops-acceptance-runner/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY services/codeops-acceptance-runner/src ./src
USER pwuser
ENTRYPOINT ["node", "src/agents-ui-smoke.mjs"]
