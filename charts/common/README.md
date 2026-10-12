# common (Helm library chart)

Not installable. Consumed by `charts/store`, `charts/platform` and `charts/upstreams`
via a `file://../common` dependency.

## Why this exists

Three of the brief's mandatory requirements are per-workload rules:

- a readiness probe and a liveness probe on every workload
- resource requests and limits on every workload
- no workload running as root with more privilege than it needs

A rule applied by hand in nine Deployments is a rule that gets forgotten in the tenth.
These partials make it **structurally impossible** to render a workload that omits any of
them: `common.resources` and `common.probes` call Helm's `fail` when the values are
missing, so the chart does not render and `helm lint` does not pass. The requirement is
enforced by the template, not by review.

## Contract

Partials that need per-component data take a three-key dict:

```
{{- include "common.containerDefaults" (dict "root" $ "component" "gateway" "spec" .Values.gateway) }}
```

| Key | Meaning |
| --- | --- |
| `root` | the chart root context (`$`), for `.Values`, `.Chart`, `.Release` |
| `component` | the component name; used in labels and in error messages |
| `spec` | that component's values subtree (`image`, `resources`, `probes`, …) |

Partials that need nothing but the root context take `.` directly
(`common.labels`, `common.fullname`).

## Partials

| Name | Takes | Emits |
| --- | --- | --- |
| `common.name` / `common.fullname` / `common.chart` | root | name strings |
| `common.labels` | root | the recommended `app.kubernetes.io/*` label set |
| `common.componentLabels` | dict | `common.labels` plus `component` |
| `common.selectorLabels` | dict | the immutable subset used in a selector |
| `common.image` | dict | `registry/repository@digest` or `:tag` |
| `common.resources` | dict | `resources:`; **fails** if requests or limits are missing |
| `common.probes` | dict | `readinessProbe:` / `livenessProbe:` / optional `startupProbe:`; **fails** if either required probe is missing |
| `common.podSecurityContext` | dict | pod-level hardening |
| `common.containerSecurityContext` | dict | container-level hardening |
| `common.containerDefaults` | dict | image, pull policy, securityContext, resources and probes in one block |

## Usage sketch

```yaml
spec:
  template:
    spec:
      {{- include "common.podSecurityContext" (dict "root" $ "component" "gateway" "spec" .Values.gateway) | nindent 6 }}
      containers:
        - name: gateway
          {{- include "common.containerDefaults" (dict "root" $ "component" "gateway" "spec" .Values.gateway) | nindent 10 }}
          env:
            - name: PORT
              value: "3000"
```
