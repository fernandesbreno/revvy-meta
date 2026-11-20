FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY package.json ./
COPY etapas.json ./
COPY src ./src
# Roda como root: o volume /data do Easypanel é montado com dono root, e o usuário node não conseguiria gravar nele
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1
# APP_MODE=mcp sobe o conector MCP único (src/mcp-hub.js); sem ele, o app de sempre
CMD ["sh", "-c", "if [ \"$APP_MODE\" = mcp ]; then exec node src/mcp-hub.js; else exec node src/server.js; fi"]
