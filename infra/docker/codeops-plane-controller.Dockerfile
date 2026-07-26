FROM node:24-bookworm-slim AS build
WORKDIR /repo

COPY tsconfig.json ./tsconfig.json
COPY packages/codeops-contracts/package.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/tsconfig.json packages/codeops-contracts/tsconfig.build.json ./packages/codeops-contracts/
COPY packages/codeops-contracts/src ./packages/codeops-contracts/src

COPY services/codeops-plane-controller/package.json services/codeops-plane-controller/package-lock.json ./services/codeops-plane-controller/
RUN npm ci --ignore-scripts --prefix services/codeops-plane-controller \
  && ln -s services/codeops-plane-controller/node_modules node_modules
COPY services/codeops-plane-controller/tsconfig.json services/codeops-plane-controller/tsconfig.build.json ./services/codeops-plane-controller/
COPY services/codeops-plane-controller/src ./services/codeops-plane-controller/src
RUN services/codeops-plane-controller/node_modules/.bin/tsc -p packages/codeops-contracts/tsconfig.build.json \
  && npm run build --prefix services/codeops-plane-controller \
  && npm prune --omit=dev --prefix services/codeops-plane-controller \
  && test -f services/codeops-plane-controller/dist/runtime-main.js \
  && test -f packages/codeops-contracts/dist/index.js \
  && rm services/codeops-plane-controller/node_modules/@renoconcierge/codeops-contracts \
  && mkdir services/codeops-plane-controller/node_modules/@renoconcierge/codeops-contracts \
  && cp packages/codeops-contracts/package.json services/codeops-plane-controller/node_modules/@renoconcierge/codeops-contracts/ \
  && cp -R packages/codeops-contracts/dist services/codeops-plane-controller/node_modules/@renoconcierge/codeops-contracts/

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /repo/services/codeops-plane-controller ./services/codeops-plane-controller
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "services/codeops-plane-controller/dist/runtime-main.js"]
