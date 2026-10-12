{{/*
Chart-local names. Everything generic lives in charts/common; this file holds only what is
specific to a store release. All of these take the root context directly: `include
"store.mariadb.name" $`.
*/}}

{{- define "store.mariadb.name" -}}
{{- include "common.componentName" (dict "root" . "component" "mariadb") -}}
{{- end -}}

{{- define "store.wordpress.name" -}}
{{- include "common.componentName" (dict "root" . "component" "wordpress") -}}
{{- end -}}

{{- define "store.wooMcp.name" -}}
{{- include "common.componentName" (dict "root" . "component" "woo-mcp") -}}
{{- end -}}

{{/*
The store's canonical hostname.

woo-mcp sends this as the Host header when it calls the WooCommerce REST API over the
in-cluster Service address. WordPress compares the Host header against its configured
siteurl and issues a redirect when they differ, so without this a perfectly routed
in-cluster request comes back as a 301 to the public URL.
*/}}
{{- define "store.host" -}}
{{- .Values.store.host | required "store.host is required" -}}
{{- end -}}

{{- define "store.mariadb.secretName" -}}
{{- if .Values.mariadb.auth.existingSecret -}}
{{- .Values.mariadb.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-mariadb" (include "common.fullname" .) -}}
{{- end -}}
{{- end -}}
