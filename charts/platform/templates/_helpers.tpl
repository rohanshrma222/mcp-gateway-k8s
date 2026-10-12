{{/*
Chart-local names for the control plane.
*/}}

{{- define "platform.postgres.name" -}}
{{- include "common.componentName" (dict "root" .root "component" "postgres") -}}
{{- end -}}

{{- define "platform.gateway.name" -}}
{{- include "common.componentName" (dict "root" .root "component" "gateway") -}}
{{- end -}}

{{- define "platform.dashboard.name" -}}
{{- include "common.componentName" (dict "root" .root "component" "dashboard") -}}
{{- end -}}

{{- define "platform.postgres.secretName" -}}
{{- if .Values.postgres.auth.existingSecret -}}
{{- .Values.postgres.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-postgres" (include "common.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Postgres connection URL, assembled in the chart rather than stored anywhere.

Deliberately built from the Secret's parts at pod start (as separate env vars consumed by
the app) rather than written into a ConfigMap as one string - a DSN in a ConfigMap is a
password in plaintext in the API server, readable by anyone with get on configmaps.
*/}}
{{- define "platform.postgres.host" -}}
{{- include "platform.postgres.name" (dict "root" .) -}}
{{- end -}}
