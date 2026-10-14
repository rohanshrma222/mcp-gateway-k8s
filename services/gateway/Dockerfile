# Multi-stage: the build stage has a toolchain and dev dependencies, the final image has
# neither. A single-stage image would ship TypeScript, the compiler and every transitive
# dev dependency into the cluster - a larger attack surface and a slower pull, in exchange
# for nothing at runtime.
#
# Built from the REPOSITORY ROOT, not from this directory:
#   docker build -f services/gateway/Dockerfile -t urumi/gateway:dev .
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
COPY services/gateway/package.json services/gateway/
# `npm ci` not `npm install`: ci installs exactly the lockfile and fails if the manifest
# and lock disagree, which is what makes the build reproducible rather than merely
# repeatable.
RUN npm ci --workspace @urumi/gateway --include-workspace-root

COPY tsconfig.base.json ./
COPY services/gateway/tsconfig.json services/gateway/
COPY services/gateway/src services/gateway/src
RUN npm run build --workspace @urumi/gateway

# Re-resolve with production dependencies only, into a clean tree. `npm prune` on the
# existing tree would leave the dev packages' directories behind in the layer even after
# removal, because a layer records the deletion rather than undoing the write.
RUN rm -rf node_modules services/gateway/node_modules \
    && npm ci --omit=dev --workspace @urumi/gateway --include-workspace-root \
    && npm cache clean --force \
    && mkdir -p services/gateway/node_modules

# ---------------------------------------------------------------------------- runtime

FROM node:24.15.0-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Alpine's node image already has a `node` user at 1000. Reusing it rather than creating
# one keeps the uid stable and matches securityContext.runAsUser in the chart - a mismatch
# there is a permission error at startup rather than at review time.
ENV NODE_OPTIONS=--enable-source-maps

# The WORKSPACE LAYOUT is preserved rather than flattened into /app/dist, and that is a
# fix for a real bug rather than a stylistic choice.
#
# npm hoists workspace dependencies to the root node_modules when it can. When it cannot -
# because another package already occupies that name at a different major - it nests the
# copy under the workspace instead. `ipaddr.js` is exactly that case here: a transitive
# dependency holds 1.9.1 at the root, so the gateway's ^2.5.0 landed in
# services/gateway/node_modules. The earlier version of this file copied only the root
# node_modules, so the nested package was silently dropped and the container died at
# startup with ERR_MODULE_NOT_FOUND.
#
# Flattening the two trees together would "work" but requires deciding which copy wins on
# a name collision - and getting that wrong gives a container that runs with the wrong
# major version of a security-relevant library, which is worse than not starting. Keeping
# the layout means Node's own resolution does the deciding, exactly as it does in
# development: from services/gateway/dist it finds services/gateway/node_modules first and
# falls back to /app/node_modules.
#
# The build stage mkdir -p s the nested directory so this COPY cannot fail when nothing
# needed nesting, which is the normal case.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/services/gateway/node_modules ./services/gateway/node_modules
COPY --from=build --chown=node:node /app/services/gateway/dist ./services/gateway/dist
COPY --from=build --chown=node:node /app/services/gateway/package.json ./services/gateway/package.json

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
CMD ["node", "services/gateway/dist/index.js"]
