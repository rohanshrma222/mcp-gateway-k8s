{{/*
Probes - MANDATORY, enforced here.

readiness and liveness are both required; startup is optional and only emitted when
given.

The distinction matters and is worth stating plainly, because conflating the two is the
most common way to make an outage worse:

  readiness  "should this pod receive traffic right now?" Failing it removes the pod from
             its Service endpoints and nothing is killed. This is what protects a rolling
             upgrade: WordPress is not added to the Service until it can actually serve.

  liveness   "is this process wedged beyond recovery?" Failing it kills the container.
             A liveness probe pointed at a dependency - a database, an upstream MCP
             server - converts that dependency's outage into a restart loop of your own,
             so these must only check the process itself.

  startup    suppresses liveness until a slow boot finishes. Used for MariaDB and
             WordPress, where first-run initialisation is far slower than steady state,
             and the alternative is a liveness timeout long enough to be useless later.
*/}}
{{- define "common.probes" -}}
{{- $spec := .spec | default dict -}}
{{- $p := $spec.probes | default dict -}}
{{- $missing := list -}}
{{- if not $p.readiness }}{{- $missing = append $missing "probes.readiness" }}{{- end -}}
{{- if not $p.liveness }}{{- $missing = append $missing "probes.liveness" }}{{- end -}}
{{- if $missing -}}
{{- fail (printf "chart %s: component %q is missing %s. Every workload must declare a readiness and a liveness probe (see charts/common/templates/_probes.tpl)." .root.Chart.Name .component (join ", " $missing)) -}}
{{- end -}}
readinessProbe:
  {{- toYaml $p.readiness | nindent 2 }}
livenessProbe:
  {{- toYaml $p.liveness | nindent 2 }}
{{- with $p.startup }}
startupProbe:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
