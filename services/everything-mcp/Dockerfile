# A third-party MCP server, built by us rather than pulled as someone else's image.
#
# Built from the REPOSITORY ROOT:
#   docker build -f services/everything-mcp/Dockerfile -t urumi/everything-mcp:dev .
#
# The brief wants at least three upstream servers, and a system where every upstream was
# written by the same person is not really being tested - the interesting failures are the
# ones you do not control. This is that upstream: the reference "everything" server, which
# exists to exercise awkward corners of the protocol.
#
# **Why a Dockerfile and not an image.** There is no official, trustworthy `mcp/everything`
# image to pull. Pulling an unofficial one would mean running bytes nobody in this project
# has looked at, on the cluster that holds every upstream credential - which is exactly the
# supply-chain risk the threat model is supposed to be about. Building it ourselves means
# the base image is digest-pinned, the package version is exact, and the root
# package-lock.json carries its integrity hash, so a rebuild either produces the same
# dependency or fails. We still did not write the server; we do control how it arrives.
#
# **What it is NOT.** It is not trusted. It runs in the upstream namespace with the same
# default-deny NetworkPolicy as notes-mcp, non-root, read-only root filesystem, every
# capability dropped, and no credential of any kind in its environment. Its `get-env` tool
# returns its own environment to any caller, which is precisely why that environment must be
# boring - and proving it is boring is one of this step's tests.

FROM node:24.15.0-alpine AS build
WORKDIR /app

# Manifests first so the dependency layer caches on the lockfile rather than on every edit.
COPY package.json package-lock.json ./
COPY services/everything-mcp/package.json services/everything-mcp/
# `npm ci --omit=dev` straight away: this workspace has no build step and no dev
# dependencies of its own, so there is nothing to compile and nothing to prune. ci rather
# than install, so the integrity hashes in the lockfile are enforced - which is the whole
# point of vendoring a third-party server this way.
RUN npm ci --omit=dev --workspace @urumi/everything-mcp --include-workspace-root \
    && npm cache clean --force \
    && mkdir -p services/everything-mcp/node_modules

# ---------------------------------------------------------------------------- runtime

FROM node:24.15.0-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# The server reads PORT and defaults to 3001. Set to 3000 so all three upstreams listen on
# the same port and the charts, probes and NetworkPolicies do not need a special case for
# this one.
ENV PORT=3000

# The workspace layout is preserved rather than flattened, for the reason spelled out in
# the other two Dockerfiles: npm nests a dependency under the workspace when it cannot
# hoist it, and copying only the root node_modules silently drops it. That bug cost real
# time in 4.6, and it is cheaper to keep the layout than to re-learn it.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/services/everything-mcp/node_modules ./services/everything-mcp/node_modules
COPY --from=build --chown=node:node /app/services/everything-mcp/package.json ./services/everything-mcp/package.json

USER node

EXPOSE 3000

# `streamableHttp` is argv[2]. The same package also offers `stdio` and `sse`, and the
# default when no argument is given is stdio - which would start, log nothing useful, and
# never answer an HTTP request, so the pod would pass a TCP probe while being useless.
# Naming the transport explicitly is the difference between a working upstream and a
# confusing one.
#
# Exec form, so node is PID 1 and receives SIGTERM directly rather than through a shell
# that does not forward signals.
CMD ["node", "node_modules/@modelcontextprotocol/server-everything/dist/index.js", "streamableHttp"]
