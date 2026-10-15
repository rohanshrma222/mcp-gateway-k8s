# The dashboard: a Vite + React bundle, served by nginx.
#
# Two stages as of step 7.1, exactly as the single-stage version predicted: a Node builder
# runs `vite build`, and the runtime stage copies `dist` instead of `public`. Worth noting
# what did NOT change - the nginx config, the base image, the uid, the read-only
# filesystem, the CSP - because establishing those in 4.7 against a placeholder is what
# made this step a build-stage addition rather than a rewrite.
#
# The runtime image contains no Node, no npm and no source: it is nginx and a directory of
# hashed static files. That is the real argument for the split here, beyond image size -
# there is no JavaScript runtime in the serving container to exploit.
#
# Built from the REPOSITORY ROOT for consistency with the other services:
#   docker build -f services/dashboard/Dockerfile -t urumi/dashboard:dev .

# ------------------------------------------------------------------------------- build

FROM node:24.15.0-alpine AS build
WORKDIR /app

# Manifests before sources so the dependency layer caches on the lockfile rather than on
# every component edit - the same ordering as the three Node services.
COPY package.json package-lock.json ./
COPY services/dashboard/package.json services/dashboard/
# `npm ci`, not install: it installs exactly the lockfile and fails if the manifest and
# lock disagree, which is what makes the bundle reproducible. Dev dependencies ARE needed
# here - vite and tsc are the build - and none of them reach the runtime stage.
RUN npm ci --workspace @urumi/dashboard --include-workspace-root

COPY tsconfig.base.json ./
COPY services/dashboard/tsconfig.json services/dashboard/vite.config.ts services/dashboard/index.html services/dashboard/
COPY services/dashboard/src services/dashboard/src
# `tsc -b && vite build`: the typecheck runs first and fails the image on a type error.
# Vite alone would strip the types and happily ship code that does not compile, so without
# this the only thing enforcing the strict flags would be a human remembering to run tsc.
RUN npm run build --workspace @urumi/dashboard

# ----------------------------------------------------------------------------- runtime

# nginx-unprivileged rather than the standard nginx image, and that is the whole reason
# this base was chosen. The standard image starts as root to bind port 80 and then drops
# to nginx for workers; this one runs entirely as uid 101 and listens on 8080, so the pod
# needs no capabilities at all. It also writes its pid to /tmp rather than /run, which is
# what makes a read-only root filesystem workable.
#
# Digest-pinned on top of the tag: a tag can be repointed at different bytes, a digest
# cannot, and the point of pinning is that a rebuild produces the same base.
FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6

# conf.d, not a replacement for /etc/nginx/nginx.conf. The base config already sets the
# uid, the pid path and sensible worker defaults; overwriting it would mean re-deriving
# those and getting the read-only filesystem wrong.
COPY --chown=101:101 services/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
# The built bundle, not the source. `dist` holds index.html plus content-hashed assets
# under /assets, which is the layout nginx.conf's cache rules were written against: a year
# of `immutable` on /assets is only safe because the filename changes when the content
# does, and index.html is `no-store` so a deploy cannot leave a browser holding a document
# that points at asset names which no longer exist.
COPY --from=build --chown=101:101 /app/services/dashboard/dist/ /usr/share/nginx/html/

# Already the image default; stated so a future edit cannot quietly lose it, and so the
# uid matches securityContext.runAsUser in the chart - a mismatch there is a permission
# error at startup rather than at review time.
USER 101

EXPOSE 8080

# No HEALTHCHECK: Kubernetes probes own this, and a Docker healthcheck would be a second,
# invisible definition of health that nothing in the cluster reads. The probe target is
# /healthz, served by nginx itself rather than by a file, so it cannot pass because of a
# stale index.html or fail because of an unrelated asset.
#
# The base image's entrypoint handles template expansion and then execs nginx, so nginx
# receives SIGTERM/SIGQUIT directly.
CMD ["nginx", "-g", "daemon off;"]
