FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/anulman/codeops" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app/services/codeops-model-proxy
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/codeops/
COPY services/codeops-model-proxy/package.json services/codeops-model-proxy/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev \
  && npm cache clean --force
COPY services/codeops-model-proxy/.env.schema ./
COPY services/codeops-model-proxy/src ./src
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "--import", "varlock/auto-load", "src/runtime-main.mjs"]
