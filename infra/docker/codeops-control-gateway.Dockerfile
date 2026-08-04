FROM node:24-bookworm-slim AS build
WORKDIR /repo

COPY tsconfig.json ./tsconfig.json
COPY packages/codeops-contracts/package.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/tsconfig.json packages/codeops-contracts/tsconfig.build.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/src ./packages/codeops-contracts/src

COPY services/codeops-control-gateway/package.json services/codeops-control-gateway/package-lock.json ./services/codeops-control-gateway/
RUN npm ci --ignore-scripts --prefix services/codeops-control-gateway \
  && ln -s services/codeops-control-gateway/node_modules node_modules
COPY services/codeops-control-gateway/tsconfig.json services/codeops-control-gateway/tsconfig.build.json ./services/codeops-control-gateway/
COPY services/codeops-control-gateway/src ./services/codeops-control-gateway/src
COPY services/codeops-control-gateway/sql ./services/codeops-control-gateway/sql
RUN services/codeops-control-gateway/node_modules/.bin/tsc -p packages/codeops-contracts/tsconfig.build.json \
  && npm run build --prefix services/codeops-control-gateway \
  && npm prune --omit=dev --prefix services/codeops-control-gateway \
  && test -f services/codeops-control-gateway/dist/runtime-main.js \
  && rm services/codeops-control-gateway/node_modules/@renoconcierge/codeops-contracts \
  && mkdir services/codeops-control-gateway/node_modules/@renoconcierge/codeops-contracts \
  && cp packages/codeops-contracts/package.json services/codeops-control-gateway/node_modules/@renoconcierge/codeops-contracts/ \
  && cp -R packages/codeops-contracts/dist services/codeops-control-gateway/node_modules/@renoconcierge/codeops-contracts/

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /repo/services/codeops-control-gateway ./services/codeops-control-gateway
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "services/codeops-control-gateway/dist/runtime-main.js"]
