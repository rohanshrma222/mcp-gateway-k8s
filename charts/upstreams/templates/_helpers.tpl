{{/*
Chart-local names for the extra MCP servers.
*/}}

{{- define "upstreams.notesMcp.name" -}}
{{- include "common.componentName" (dict "root" .root "component" "notes-mcp") -}}
{{- end -}}

{{- define "upstreams.everythingMcp.name" -}}
{{- include "common.componentName" (dict "root" .root "component" "everything-mcp") -}}
{{- end -}}
