FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DZ23_STATE_DIR=/state \
    DZ23_HTTP_HOST=0.0.0.0 \
    DZ23_HTTP_PORT=8787
# Code stays root-owned and read-only for the runtime user; no .env or state enters the image.
COPY package.json ./
COPY src ./src
COPY scripts/docker-healthcheck.mjs ./scripts/docker-healthcheck.mjs
RUN addgroup -S dz23 && adduser -S -G dz23 dz23 \
 && mkdir -p /state && chown dz23:dz23 /state && chmod 700 /state
USER dz23
VOLUME ["/state"]
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "scripts/docker-healthcheck.mjs"]
# HTTP still refuses to start without DZ23_ALLOW_HTTP=true and a 32+ character token (0.0.0.0 bind).
CMD ["node", "src/index.js", "--http"]
