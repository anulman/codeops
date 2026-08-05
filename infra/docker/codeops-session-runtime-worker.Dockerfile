FROM node:24-bookworm-slim AS build
WORKDIR /repo

COPY tsconfig.json ./tsconfig.json
COPY packages/codeops-contracts/package.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/tsconfig.json packages/codeops-contracts/tsconfig.build.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/src ./packages/codeops-contracts/src

COPY services/codeops-session-runtime-worker/package.json services/codeops-session-runtime-worker/package-lock.json ./services/codeops-session-runtime-worker/
RUN npm ci --ignore-scripts --prefix services/codeops-session-runtime-worker \
  && ln -s services/codeops-session-runtime-worker/node_modules node_modules
COPY services/codeops-session-runtime-worker/tsconfig.json services/codeops-session-runtime-worker/tsconfig.build.json ./services/codeops-session-runtime-worker/
COPY services/codeops-session-runtime-worker/src ./services/codeops-session-runtime-worker/src
RUN services/codeops-session-runtime-worker/node_modules/.bin/tsc -p packages/codeops-contracts/tsconfig.build.json \
  && npm run build --prefix services/codeops-session-runtime-worker \
  && npm prune --omit=dev --prefix services/codeops-session-runtime-worker \
  && test -f services/codeops-session-runtime-worker/dist/runtime-main.js \
  && rm services/codeops-session-runtime-worker/node_modules/@renoconcierge/codeops-contracts \
  && mkdir services/codeops-session-runtime-worker/node_modules/@renoconcierge/codeops-contracts \
  && cp packages/codeops-contracts/package.json services/codeops-session-runtime-worker/node_modules/@renoconcierge/codeops-contracts/ \
  && cp -R packages/codeops-contracts/dist services/codeops-session-runtime-worker/node_modules/@renoconcierge/codeops-contracts/

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /repo/services/codeops-session-runtime-worker ./services/codeops-session-runtime-worker
ENV NODE_ENV=production
USER node
CMD ["node", "services/codeops-session-runtime-worker/dist/runtime-main.js"]
