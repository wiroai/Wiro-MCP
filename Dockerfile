# syntax=docker/dockerfile:1

# Runs the Wiro MCP server over stdio:
#   docker run -i --rm -e WIRO_API_KEY wiroai/wiro-mcp

# The build stage runs on the build machine's own platform. Its output is plain
# JavaScript and no dependency ships native code, so the same files serve both
# amd64 and arm64, and the final stage only copies them.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine
LABEL org.opencontainers.image.title="Wiro MCP Server" \
      org.opencontainers.image.description="Official MCP server for Wiro AI: run AI models, build and run workflows, and deploy and talk to AI agents." \
      org.opencontainers.image.url="https://wiro.ai/docs/wiro-mcp-server" \
      org.opencontainers.image.source="https://github.com/wiroai/Wiro-MCP" \
      org.opencontainers.image.vendor="Wiro AI" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="ai.wiro/mcp"
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE ./
# The base image's node user, by number so that runtimes which check for a
# non-root user (Kubernetes runAsNonRoot, for one) can verify it.
USER 1000:1000
ENTRYPOINT ["node", "dist/index.js"]
