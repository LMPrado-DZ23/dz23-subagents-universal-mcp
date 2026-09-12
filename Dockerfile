FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN addgroup -S dz23 && adduser -S -G dz23 dz23 && mkdir -p /state && chown -R dz23:dz23 /app /state
USER dz23
ENV DZ23_STATE_DIR=/state DZ23_HTTP_HOST=0.0.0.0 DZ23_HTTP_PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/healthz',{headers:process.env.DZ23_MCP_TOKEN?{authorization:'Bearer '+process.env.DZ23_MCP_TOKEN}:{}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","src/index.js","--http"]
