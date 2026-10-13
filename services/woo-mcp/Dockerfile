# Multi-stage: the build stage has a toolchain and dev dependencies, the final image has
# neither. A single-stage image would ship TypeScript, the compiler and every transitive
# dev dependency into the cluster - a larger attack surface and a slower pull, in exchange
# for nothing at runtime.
#
# Built from the REPOSITORY ROOT, not from this directory:
#   docker build -f services/woo-mcp/Dockerfile -t urumi/woo-mcp:dev .
# because this is an npm workspace and the root package-lock.json is the only file that
# pins the dependency tree. Copying just this service would mean resolving dependencies
# fresh at build time, so the image would not be reproducible from the lockfile.

# Digest-pinned: a tag can be repointed at different bytes, a digest cannot, and the point
# of pinning is that a rebuild produces the same base.
FROM node:24.15.0-alpine AS build
WORKDIR /app

# Manifests before sources, so the dependency layer is cached and only re-resolves when
# the lockfile actually changes - not on every source edit.
COPY package.json package-lock.json ./
COPY services/woo-mcp/package.json services/woo-mcp/
# `npm ci` not `npm install`: ci installs exactly the lockfile and fails if the manifest
# and lock disagree, which is what makes the build reproducible rather than merely
# repeatable.
RUN npm ci --workspace @urumi/woo-mcp --include-workspace-root

COPY tsconfig.base.json ./
COPY services/woo-mcp/tsconfig.json services/woo-mcp/
COPY services/woo-mcp/src services/woo-mcp/src
RUN npm run build --workspace @urumi/woo-mcp

# Re-resolve with production dependencies only, into a clean tree. `npm prune` on the
# existing tree would leave the dev packages' directories behind in the layer even after
# removal, because a layer records the deletion rather than undoing the write.
RUN rm -rf node_modules services/woo-mcp/node_modules \
    && npm ci --omit=dev --workspace @urumi/woo-mcp --include-workspace-root \
    && npm cache clean --force

# ---------------------------------------------------------------------------- runtime

FROM node:24.15.0-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Alpine's node image already has a `node` user at 1000. Reusing it rather than creating
# one keeps the uid stable and matches securityContext.runAsUser in the chart - a mismatch
# there is a permission error at startup rather than at review time.
ENV NODE_OPTIONS=--enable-source-maps

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/services/woo-mcp/dist ./dist
COPY --from=build --chown=node:node /app/services/woo-mcp/package.json ./package.json

# Non-root in the image itself, not only in the pod spec. The chart sets runAsNonRoot and
# would reject a root image, but a container that is only safe because of how it is
# deployed is one `docker run` away from not being safe.
USER node

EXPOSE 3000

# No HEALTHCHECK instruction: Kubernetes probes own this, and a Docker healthcheck would
# be a second, invisible definition of health that nothing in the cluster reads.
#
# Exec form, so node is PID 1 and receives SIGTERM directly. The shell form would wrap it
# in /bin/sh, which does not forward signals, so graceful shutdown would never run and
# every rollout would kill in-flight tool calls.
CMD ["node", "dist/index.js"]
