{{/*
Resource requests and limits - MANDATORY, enforced here.

The brief requires requests and limits on every workload. Rather than trusting nine
Deployments to remember, this partial calls `fail` when they are absent: the chart does
not render, `helm lint` does not pass, and the omission is caught before a cluster is
involved.

Why each is required, since "because the brief says so" is not an answer:

  requests.cpu / requests.memory  the scheduler places pods on requests alone. With none,
                                  every pod looks free, the node is overcommitted, and the
                                  kubelet starts evicting under pressure - picking victims
                                  by how far they exceed their requests, so a pod with no
                                  request is a first-class eviction target.

  limits.memory                   memory is incompressible. Without a limit, one leaking
                                  process takes the node down with it, and the blast
                                  radius is every other workload on that node.

  limits.cpu                      required by the brief. Worth knowing the tradeoff: a CPU
                                  limit is enforced by CFS throttling, which can add tail
                                  latency to a bursty service even while the node has idle
                                  cores. Memory limits prevent a node from dying; CPU
                                  limits mostly prevent noisy neighbours. We set both and
                                  keep the CPU limits generous.
*/}}
{{- define "common.resources" -}}
{{- $spec := .spec | default dict -}}
{{- $r := $spec.resources | default dict -}}
{{- $req := $r.requests | default dict -}}
{{- $lim := $r.limits | default dict -}}
{{- $missing := list -}}
{{- if not $req.cpu }}{{- $missing = append $missing "resources.requests.cpu" }}{{- end -}}
{{- if not $req.memory }}{{- $missing = append $missing "resources.requests.memory" }}{{- end -}}
{{- if not $lim.cpu }}{{- $missing = append $missing "resources.limits.cpu" }}{{- end -}}
{{- if not $lim.memory }}{{- $missing = append $missing "resources.limits.memory" }}{{- end -}}
{{- if $missing -}}
{{- fail (printf "chart %s: component %q is missing %s. Every workload must declare requests and limits (see charts/common/templates/_resources.tpl)." .root.Chart.Name .component (join ", " $missing)) -}}
{{- end -}}
resources:
  {{- toYaml $r | nindent 2 }}
{{- end -}}
