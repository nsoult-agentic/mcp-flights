FROM oven/bun:1.3.10-alpine AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production

FROM oven/bun:1.3.10-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

USER bun

EXPOSE 8907
LABEL org.opencontainers.image.source=https://github.com/nsoult-agentic/mcp-flights

CMD ["bun", "run", "src/http.ts"]
