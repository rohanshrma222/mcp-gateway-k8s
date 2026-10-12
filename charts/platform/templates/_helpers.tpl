{{/*
Chart-local names for the control plane. All take the root context directly.
*/}}

{{- define "platform.postgres.name" -}}
{{- include "common.componentName" (dict "root" . "component" "postgres") -}}
{{- end -}}

{{- define "platform.gateway.name" -}}
{{- include "common.componentName" (dict "root" . "component" "gateway") -}}
{{- end -}}

{{- define "platform.dashboard.name" -}}
{{- include "common.componentName" (dict "root" . "component" "dashboard") -}}
{{- end -}}

{{- define "platform.postgres.secretName" -}}
{{- if .Values.postgres.auth.existingSecret -}}
{{- .Values.postgres.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-postgres" (include "common.fullname" .) -}}
{{- end -}}
{{- end -}}
