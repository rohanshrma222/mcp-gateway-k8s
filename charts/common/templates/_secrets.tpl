{{/*
Generated-but-stable secret values.

The problem this solves: `randAlphaNum` is re-evaluated on every render, so the naive
version rotates every password on every `helm upgrade`. For a stateless service that is
merely surprising. For MariaDB and Postgres it is data loss in slow motion - the PVC
still holds a database whose user has the old password, the new Secret says otherwise,
and the pod never becomes ready again.

So: look up the Secret that already exists in the release namespace and reuse the value
if it is there, and only generate when it is not. First install generates; every upgrade
after that is a no-op. Rotation becomes an explicit act - delete the Secret, or point
`existingSecret` at one you manage - rather than an accident.

Returns a base64 value, ready for a Secret's `data:` map.

Caveat worth volunteering: `lookup` returns an empty dict during `helm template` and
`--dry-run`, because there is no cluster to query. So rendered output shows a fresh
random value every time, and a template diff between two renders will show these keys as
changed even when nothing has. That is a property of the function, not a bug here, and it
is why the values files let you supply an existingSecret instead for production.
*/}}
{{- define "common.secretValue" -}}
{{- $existing := lookup "v1" "Secret" .root.Release.Namespace .name -}}
{{- if and $existing $existing.data (index $existing.data .key) -}}
{{- index $existing.data .key -}}
{{- else -}}
{{- randAlphaNum (.length | default 32) | b64enc -}}
{{- end -}}
{{- end -}}

{{/*
The same generate-but-stable pattern, for a value that must be HEX.

`randAlphaNum` returns mixed-case alphanumerics, which is fine for a password and wrong
for a key with a declared encoding. The gateway's ENCRYPTION_KEY is an AES-256-GCM key
validated as exactly 64 lowercase hex characters, and a generated value that fails that
validation would be a chart that installs and a pod that refuses to start.

sha256sum of a random string gives exactly 64 lowercase hex characters. The entropy comes
from the random input, not from the hash - the hash is only doing the encoding.

Hex rather than base64 for this key because the length is then unambiguous: 64 characters
is 32 bytes, and a truncated value is obvious on sight rather than decoding to something
short.
*/}}
{{- define "common.secretHexValue" -}}
{{- $existing := lookup "v1" "Secret" .root.Release.Namespace .name -}}
{{- if and $existing $existing.data (index $existing.data .key) -}}
{{- index $existing.data .key -}}
{{- else -}}
{{- randAlphaNum 64 | sha256sum | b64enc -}}
{{- end -}}
{{- end -}}
