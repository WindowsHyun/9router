# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app
# CN mirror for apk (used by builder and runner stages)
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories

FROM base AS builder

RUN apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

COPY package.json ./
RUN npm install --registry=https://registry.npmmirror.com

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1

# The Next/webpack build is this image's memory high-water mark. If it dies
# partway through compiling with:
#
#   FATAL ERROR: Ineffective mark-compacts near heap limit
#   Allocation failed - JavaScript heap out of memory
#
# then the builder's heap is the problem, not the code. Raise it:
#
#   docker build --build-arg NODE_BUILD_HEAP_MB=8192 .
#
# Deliberately empty by default, which leaves Node to size its own old space
# exactly as it does today — this image is known to build as-is, and pinning a
# number lower than the default Node picks would *introduce* the failure above.
# The build host needs that much RAM actually free, or the kernel kills the
# process and you get `Killed` instead of V8's message.
ARG NODE_BUILD_HEAP_MB=
RUN if [ -n "$NODE_BUILD_HEAP_MB" ]; then \
      export NODE_OPTIONS="--max-old-space-size=${NODE_BUILD_HEAP_MB}"; \
      echo "build heap: ${NODE_BUILD_HEAP_MB} MB"; \
    fi; \
    npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

# Claude Code ships inside the image so the claude-cli provider works out of the
# box — installing 9Router is meant to be the whole install. Pinned, because an
# unpinned CLI would change what routed requests run on every image rebuild.
ARG CLAUDE_CODE_VERSION=2.1.278
ARG NPM_REGISTRY
RUN npm install -g --registry="${NPM_REGISTRY:-https://registry.npmjs.org}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force
# Where the provider looks; CLI_CLAUDE_BIN overrides it.
ENV CLI_CLAUDE_BIN=/usr/local/bin/claude
# The container has no terminal for the sign-in TUI, so accounts are attached
# with a token from `claude setup-token` (run on any machine that has one).
# The dashboard's Claude Code accounts card takes it.
ENV CLAUDE_CONFIG_DIR=/app/data-home/claude

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
# Required by custom-server.js to serve the ChatGPT Web sign-in console on this
# origin. The require fails soft, so leaving it out would not crash the server —
# it would just make the dashboard's Login button do nothing.
COPY --from=builder /app/bridge-vnc-proxy.cjs ./bridge-vnc-proxy.cjs
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home /app/data-home/claude && chown -R node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Fix permissions at runtime (handles mounted volumes).
#
# A file rather than a printf one-liner: it now skips the ChatGPT Web bridge's
# browser profile, which is worth being able to read. See the script.
RUN apk --no-cache upgrade && apk --no-cache add su-exec
COPY docker/router-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && sh -n /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
