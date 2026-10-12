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
