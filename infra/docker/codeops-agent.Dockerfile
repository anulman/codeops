FROM node:24-trixie-slim AS build
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

FROM node:24-trixie-slim
LABEL org.opencontainers.image.source="https://github.com/anulman/codeops" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /opt/codeops-agent
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/codeops/
COPY LICENSE /usr/share/licenses/helm/LICENSE
COPY infra/licenses/NUB-LICENSE /usr/share/licenses/nub/LICENSE
COPY --from=build /repo/services/codeops-agent/package.json ./
COPY --from=build /repo/services/codeops-agent/package-lock.json ./
COPY --from=build /repo/services/codeops-agent/node_modules ./node_modules
ARG HELM_VERSION=3.19.2
ARG HELM_LINUX_AMD64_SHA256=2114c9dea2844dce6d0ee2d792a9aae846be8cf53d5b19dc2988b5a0e8fec26e
ARG NUB_VERSION=0.1.11
ARG NUB_LINUX_X64_SHA256=d227290e3a45c05ff20508a961f01950c50a138b08caf76d59f403e8a721330d
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git socat \
  && curl --fail --silent --show-error --location --retry 5 --retry-all-errors \
       --output /tmp/helm.tar.gz "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" \
  && echo "${HELM_LINUX_AMD64_SHA256}  /tmp/helm.tar.gz" | sha256sum --check --strict \
  && tar -xzf /tmp/helm.tar.gz -C /tmp \
  && install -m 0555 /tmp/linux-amd64/helm /usr/local/bin/helm \
  && curl --fail --silent --show-error --location --retry 5 --retry-all-errors \
       --output /tmp/nub.tar.gz "https://github.com/nubjs/nub/releases/download/v${NUB_VERSION}/nub-linux-x64.tar.gz" \
  && echo "${NUB_LINUX_X64_SHA256}  /tmp/nub.tar.gz" | sha256sum --check --strict \
  && tar -xzf /tmp/nub.tar.gz -C /tmp \
  && install -m 0555 /tmp/bin/nub /usr/local/bin/nub \
  && ln -s nub /usr/local/bin/nubx \
  && helm version --short \
  && nub --version \
  && rm -rf /tmp/helm.tar.gz /tmp/nub.tar.gz /tmp/linux-amd64 /tmp/bin \
  && apt-get purge -y --auto-remove curl \
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
