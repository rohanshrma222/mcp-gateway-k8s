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

{{/*
The Secret holding the model API key for the chat agent.

Unlike every other Secret this chart manages, this one cannot be generated. A JWT signing
key and an encryption key are just random bytes, so the chart makes them with
`common.secretValue` and nobody ever has to see them. A Groq API key is issued by Groq and
has to be brought in from outside, which changes what the chart can offer: it can carry a
value the operator supplies, or point at a Secret somebody else manages, and it cannot
invent one.

So this helper has no generated branch, and the chat agent is optional throughout -
`config.ts` makes GROQ_API_KEY the only optional secret in the schema, and the deployment
below only sets the variable when there is something to set it to.
*/}}
{{- define "platform.gateway.groqSecretName" -}}
{{- if .Values.secrets.groqExistingSecret -}}
{{- .Values.secrets.groqExistingSecret -}}
{{- else -}}
{{- printf "%s-groq" (include "common.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Whether the chat agent has a key at all, from either source.

Used in three places - the Secret, the env var and the checksum annotation - so the
condition lives here rather than being repeated and drifting.
*/}}
{{- define "platform.gateway.chatEnabled" -}}
{{- if or .Values.secrets.groqExistingSecret .Values.secrets.groqApiKey -}}true{{- end -}}
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

{{/*
Maps the logical service name used in `ingress.paths[].service` to the rendered Service
name, so the values file can say `gateway` rather than repeating a fullname template.
A name that is not one of the two is a `fail`, because the alternative is an Ingress that
renders happily and routes to a Service that does not exist.
*/}}
{{- define "platform.ingressBackend" -}}
{{- $name := .name -}}
{{- if eq $name "gateway" -}}
{{- include "platform.gateway.name" .root -}}
{{- else if eq $name "dashboard" -}}
{{- include "platform.dashboard.name" .root -}}
{{- else -}}
{{- fail (printf "ingress.paths: unknown service %q (expected \"gateway\" or \"dashboard\")" $name) -}}
{{- end -}}
{{- end -}}
