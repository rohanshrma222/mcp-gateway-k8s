{{/*
securityContext - hardened by default, relaxed only where a component declares it.

Defaults deny: non-root, no privilege escalation, every capability dropped, read-only
root filesystem, seccomp set to the runtime default profile. A component that genuinely
needs more writes `securityContext.readOnlyRootFilesystem: false` in values, which makes
the exception visible in the values file a reviewer reads rather than buried in a
template.

Two of those exceptions are already known and are not laziness:

  wordpress  writes to wp-content (plugins, uploads) on a PVC, and php-fpm writes session
             and opcache files outside it.
  mariadb    the entrypoint fixes ownership of the data directory on first run.

Our own services - gateway, woo-mcp, notes-mcp, dashboard - keep the full set, because a
Node process serving HTTP has no reason to write to its own filesystem.

automountServiceAccountToken is false by default. Nothing in this platform talks to the
Kubernetes API, so mounting a token into every pod only gives an attacker who lands in a
container a credential to work with.
*/}}

{{- define "common.podSecurityContext" -}}
{{- $sc := (.spec | default dict).securityContext | default dict -}}
securityContext:
  runAsNonRoot: {{ $sc.runAsNonRoot | default true }}
  {{- if $sc.runAsUser }}
  runAsUser: {{ $sc.runAsUser }}
  {{- end }}
  {{- if $sc.runAsGroup }}
  runAsGroup: {{ $sc.runAsGroup }}
  {{- end }}
  {{- if $sc.fsGroup }}
  {{- /* Needed when a PVC is mounted: the kubelet chowns the volume to this group so a
         non-root process can write to it. */}}
  fsGroup: {{ $sc.fsGroup }}
  {{- end }}
  seccompProfile:
    type: {{ $sc.seccompProfile | default "RuntimeDefault" }}
{{- end -}}

{{- define "common.containerSecurityContext" -}}
{{- $sc := (.spec | default dict).securityContext | default dict -}}
securityContext:
  allowPrivilegeEscalation: {{ $sc.allowPrivilegeEscalation | default false }}
  readOnlyRootFilesystem: {{ if kindIs "bool" $sc.readOnlyRootFilesystem }}{{ $sc.readOnlyRootFilesystem }}{{ else }}true{{ end }}
  privileged: false
  capabilities:
    drop:
      - ALL
    {{- with $sc.addCapabilities }}
    add:
      {{- toYaml . | nindent 6 }}
    {{- end }}
{{- end -}}

{{- define "common.automountServiceAccountToken" -}}
{{- $spec := .spec | default dict -}}
automountServiceAccountToken: {{ if kindIs "bool" $spec.automountServiceAccountToken }}{{ $spec.automountServiceAccountToken }}{{ else }}false{{ end }}
{{- end -}}
