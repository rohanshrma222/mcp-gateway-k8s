\set ON_ERROR_STOP on

-- Worst-case rows for the fields the dashboard renders, inserted at the boundary a hostile
-- or merely verbose upstream would use: mcp_tools is written by the prober from whatever
-- the upstream published, and 5.2 stores schemas and descriptions VERBATIM by design. So
-- these are not contrived - they are what the gateway would persist if an upstream sent
-- them, and nothing in either layer caps them.

-- A fake upstream to hang them off, so the real three are untouched.
INSERT INTO mcp_servers (slug, name, url, auth_type, timeout_ms, status, enabled, last_error)
VALUES (
  'wc',
  -- 200 chars, the zod maximum, as ONE unbroken token. The realistic shape: a German
  -- compound or a generated name from an import.
  repeat('Unternehmensdienstleistungsgesellschaft', 6),
  -- 2048 is the zod max; this is a realistic long one with no spaces and a query string.
  'http://a-very-long-internal-service-name-that-somebody-generated.mcp-upstreams.svc.cluster.local:3000/mcp?tenant=acme-holdings-international&region=eu-central-1',
  'none', 20000, 'unreachable', true,
  -- A realistic long failure: the pool caps the generic branch at 200, but the specific
  -- branches return fixed strings and then APPEND a countdown, so the stored value can
  -- exceed any single cap. This is that shape at its longest.
  'the upstream could not be reached: the connection could not be opened (not retrying for another 30s)'
)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, last_error = EXCLUDED.last_error;

-- Tools. These three fields have NO limit in zod, in the database, or in the prober.
INSERT INTO mcp_tools (server_id, name, prefixed_name, title, description, input_schema, last_seen_at)
SELECT s.id, t.name, 'wc__' || t.name, t.title, t.description, '{"type":"object"}'::jsonb, now()
FROM mcp_servers s,
LATERAL (VALUES
  -- A 60-char prefixed name is the clamp limit from naming.ts; this is at it.
  ('a_tool_with_an_extremely_descriptive_and_long_name_here',
   'Create Or Update A Customer Record In The Downstream System',
   -- A 4,000-character description. Nothing caps this: the Tools page renders it and
   -- /api/tools transfers it on every load.
   repeat('This tool performs a complex operation and the vendor has documented it at length. ', 48)),
  -- The one-character case, which breaks layouts that assume text fills its box.
  ('x', 'X', 'Does x.'),
  -- No title and no description at all: both are optional in MCP and the page must not
  -- render an orphaned line or a bare dash.
  ('no_metadata_at_all', NULL, NULL),
  -- Non-Latin plus emoji, which breaks naive initial-taking and tight line-heights.
  ('unicode_probe', 'ツール設定 — Configuración 🔧', 'Ein Werkzeug für die Verwaltung von Unternehmensdienstleistungen. ツールの説明。')
) AS t(name, title, description)
WHERE s.slug = 'wc'
ON CONFLICT (server_id, name) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description;

-- An audit row at the error_message cap, with no spaces in the tail so it cannot wrap.
INSERT INTO audit_log (user_id, api_key_id, user_email, server_slug, tool_name, started_at, duration_ms, outcome, error_code, error_message, actor, request_id)
SELECT u.id, NULL,
  u.email,
  'wc',
  'wc__a_tool_with_an_extremely_descriptive_and_long_name_here',
  now(), 10504, 'error', 'upstream_unreachable',
  -- 2,000 characters, the cap, ending in an unbreakable URL-shaped token.
  repeat('the upstream returned an error and included a great deal of context. ', 28) ||
  'http://a-service.a-namespace.svc.cluster.local:3000/mcp/v1/resources/00000000-0000-0000-0000-000000000000',
  'external', '00000000-0000-0000-0000-000000000000'
FROM users u WHERE u.email = 'admin@urumi.local';

-- A one-millisecond call and a two-minute one, for the duration column's extremes.
INSERT INTO audit_log (user_id, user_email, server_slug, tool_name, started_at, duration_ms, outcome, actor)
SELECT u.id, u.email, 'wc', 'wc__x', now(), 1, 'ok', 'external' FROM users u WHERE u.email='admin@urumi.local';
INSERT INTO audit_log (user_id, user_email, server_slug, tool_name, started_at, duration_ms, outcome, actor)
SELECT u.id, u.email, 'wc', 'wc__x', now(), 120000, 'timeout', 'external' FROM users u WHERE u.email='admin@urumi.local';

SELECT 'inserted' AS status;
