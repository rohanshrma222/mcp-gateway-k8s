{{/*
Chart-local names for the extra MCP servers. All take the root context directly.
*/}}

{{- define "upstreams.notesMcp.name" -}}
{{- include "common.componentName" (dict "root" . "component" "notes-mcp") -}}
{{- end -}}

{{- define "upstreams.everythingMcp.name" -}}
{{- include "common.componentName" (dict "root" . "component" "everything-mcp") -}}
{{- end -}}
