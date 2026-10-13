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

{{/*
Per-concern Secret names.

jwt and encryption are separate Secrets rather than two keys in one, because they have
genuinely different lifecycles: rotating the JWT signing key logs everyone out and is
harmless, while rotating the encryption key makes every stored upstream credential
undecryptable and is not. Keeping them apart means one can be replaced without touching
the other, and `values-prod.yaml` can point each at a different externally managed Secret.
*/}}
{{- define "platform.gateway.jwtSecretName" -}}
{{- if .Values.secrets.jwtExistingSecret -}}
{{- .Values.secrets.jwtExistingSecret -}}
{{- else -}}
{{- printf "%s-jwt" (include "common.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "platform.gateway.encryptionSecretName" -}}
{{- if .Values.secrets.encryptionExistingSecret -}}
{{- .Values.secrets.encryptionExistingSecret -}}
{{- else -}}
{{- printf "%s-encryption" (include "common.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "platform.bootstrapSecretName" -}}
{{- if .Values.secrets.bootstrapExistingSecret -}}
{{- .Values.secrets.bootstrapExistingSecret -}}
{{- else -}}
{{- printf "%s-bootstrap" (include "common.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "platform.seed.name" -}}
{{- include "common.componentName" (dict "root" . "component" "seed") -}}
{{- end -}}
