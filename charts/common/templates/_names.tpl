{{/*
Naming and labels.

One set of names across three charts means a NetworkPolicy in charts/store can select
the gateway pod from charts/platform by label without either chart knowing the other's
internals. That cross-chart selector is the whole reason these live in the library.
*/}}

{{- define "common.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "common.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Per-component object name, e.g. store-default-wordpress. */}}
{{- define "common.componentName" -}}
{{- printf "%s-%s" (include "common.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "common.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "common.labels" -}}
helm.sh/chart: {{ include "common.chart" . }}
app.kubernetes.io/name: {{ include "common.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/part-of: urumi-mcp-gateway
{{- end -}}

{{- define "common.componentLabels" -}}
{{ include "common.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Selector labels only.

Deliberately a strict subset of common.labels: a Deployment's selector is immutable
after creation, so anything that changes between releases - chart version, app version -
must stay out of it or the next `helm upgrade` fails with a field-is-immutable error.
*/}}
{{- define "common.selectorLabels" -}}
app.kubernetes.io/name: {{ include "common.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}
