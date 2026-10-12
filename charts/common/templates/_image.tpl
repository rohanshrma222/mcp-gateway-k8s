{{/*
Image reference.

Prefers a digest over a tag when one is given. Local development uses tags because
images are built and `kind load`ed on every change; values-prod.yaml pins digests, so
production cannot silently pull different bytes under the same tag.
*/}}
{{- define "common.image" -}}
{{- $global := .root.Values.global | default dict -}}
{{- $img := .spec.image | default dict -}}
{{- $repo := $img.repository | default "" -}}
{{- if not $repo -}}
{{- fail (printf "chart %s: component %q is missing image.repository" .root.Chart.Name .component) -}}
{{- end -}}
{{- $registry := $img.registry | default $global.imageRegistry | default "" -}}
{{- $prefix := "" -}}
{{- if $registry -}}
{{- $prefix = printf "%s/" $registry -}}
{{- end -}}
{{- if $img.digest -}}
{{- printf "%s%s@%s" $prefix $repo $img.digest -}}
{{- else if $img.tag -}}
{{- printf "%s%s:%s" $prefix $repo $img.tag -}}
{{- else -}}
{{- fail (printf "chart %s: component %q needs image.tag or image.digest - an implicit :latest is not reproducible" .root.Chart.Name .component) -}}
{{- end -}}
{{- end -}}

{{- define "common.imagePullPolicy" -}}
{{- $global := .root.Values.global | default dict -}}
{{- $img := .spec.image | default dict -}}
{{- $img.pullPolicy | default $global.imagePullPolicy | default "IfNotPresent" -}}
{{- end -}}
