# Obraz stacka Portainera "mcp-saos" (NAS): serwer MCP po Streamable HTTP (/mcp) + lokalna kopia dumpu SAOS
# w /data (SQLite), synchronizowana codziennie przez proces potomny (dist/sync.js). Tor tylko awaryjnie:
# ponowienia zapytan do SAOS ida przez nowy obwod Tor (SAOS_TOR=0 wylacza).
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tor && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --no-audit --no-fund && npm prune --omit=dev
COPY start.sh ./
RUN chmod 0755 start.sh
ENV MCP_TRANSPORT=http PORT=8000 SAOS_DB=/data/saos.sqlite NODE_NO_WARNINGS=1
USER 1026:100
CMD ["./start.sh"]
