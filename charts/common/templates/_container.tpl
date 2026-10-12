{{/*
Everything a container must declare, in one include.

This is the partial application templates actually call. The point is that there is no
shorter path: a template author cannot write a container without an image reference, a
pull policy, a hardened securityContext, resources and probes, because this is the block
that produces them and it refuses to render if any are missing.

  containers:
    - name: gateway
      {{- include "common.containerDefaults" (dict "root" $ "component" "gateway" "spec" .Values.gateway) | nindent 6 }}
      env: ...
*/}}
{{- define "common.containerDefaults" -}}
image: {{ include "common.image" . | quote }}
imagePullPolicy: {{ include "common.imagePullPolicy" . }}
{{ include "common.containerSecurityContext" . }}
{{ include "common.resources" . }}
{{ include "common.probes" . }}
{{- end -}}

{{/*
Ports from a list of {name, containerPort, protocol}. Named ports let a Service and a
NetworkPolicy refer to the port by name, so changing the number is a one-line change.
*/}}
{{- define "common.containerPorts" -}}
{{- with (.spec | default dict).ports -}}
ports:
  {{- range . }}
  - name: {{ .name }}
    containerPort: {{ .containerPort | required (printf "port %q needs containerPort" .name) }}
    protocol: {{ .protocol | default "TCP" }}
  {{- end }}
{{- end -}}
{{- end -}}

{{/*
The same block for a Job container.

Identical to common.containerDefaults except that it does not emit probes, because a Job
has nowhere to put them: readiness has no meaning for a pod that is expected to exit, and
a liveness probe on a batch task would restart work that is already running correctly.

This is a narrower rule, not an escape hatch - resources are still mandatory, the
securityContext is still hardened, and the image still has to be pinned. A Job that
exhausts a node is exactly as damaging as a Deployment that does, so the one guardrail
that still applies is the one that matters here.
*/}}
{{- define "common.jobContainerDefaults" -}}
image: {{ include "common.image" . | quote }}
imagePullPolicy: {{ include "common.imagePullPolicy" . }}
{{ include "common.containerSecurityContext" . }}
{{ include "common.resources" . }}
{{- end -}}
