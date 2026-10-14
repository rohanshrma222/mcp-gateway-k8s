# The dashboard: static files served by nginx.
#
# Single stage, unlike the two Node services, because there is nothing to compile yet -
# step 4.7 ships a placeholder page so the Ingress routing is verifiable now. Step 7.1
# turns this into two stages: a Node builder running `vite build`, then this stage copying
# `dist` instead of `public`. The nginx config and the hardening below do not change, which
# is the point of establishing them now.
#
# Built from the REPOSITORY ROOT for consistency with the other services:
#   docker build -f services/dashboard/Dockerfile -t urumi/dashboard:dev .

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
COPY --chown=101:101 services/dashboard/public/ /usr/share/nginx/html/

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
