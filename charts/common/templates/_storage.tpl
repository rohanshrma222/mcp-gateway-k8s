{{/*
storageClassName, emitted only when there is one.

This is a real Kubernetes gotcha rather than a style choice. Three states are distinct:

  field omitted        use the cluster default StorageClass
  storageClassName: "" do NOT use the default - bind only a manually provisioned PV
  storageClassName: x  use class x

So a naive `storageClassName: {{ .Values.global.storageClass }}` with an empty value does
not mean "use the default" - it means "never dynamically provision", and the PVC sits
Pending forever with no obvious reason. Hence the conditional: empty means omit the key.

kind provides `standard`, k3s provides `local-path`, and both are named explicitly in the
overlays rather than relying on which one happens to be marked default.
*/}}
{{- define "common.storageClassName" -}}
{{- $global := .root.Values.global | default dict -}}
{{- $p := (.spec | default dict).persistence | default dict -}}
{{- $sc := $p.storageClass | default $global.storageClass | default "" -}}
{{- if $sc -}}
storageClassName: {{ $sc | quote }}
{{- end -}}
{{- end -}}
