-- 002  The upstream registry: which MCP servers exist, and the tools they advertise.

CREATE TABLE mcp_servers (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Short, URL-safe, and the prefix used to namespace this server's tool names. The
    -- pattern is enforced here rather than only in the API, because the prefix ends up in
    -- a tool name that a model parses: a slug containing the separator would make
    -- `woo__list_products` ambiguous.
    slug        text        NOT NULL UNIQUE,
    name        text        NOT NULL,
    url         text        NOT NULL,
    auth_type   text        NOT NULL DEFAULT 'none',
    -- Only meaningful for auth_type = 'header'.
    auth_header text,

    -- The upstream's credential, AES-256-GCM. Three columns rather than one blob, because
    -- a nonce and an auth tag are not ciphertext and storing them concatenated means
    -- every reader has to agree on the byte offsets. Named for what they are.
    --
    -- This is the only secret in the database, and it is the one the API must never
    -- return: responses carry `has_credential` as a boolean, never a value. Encrypted at
    -- rest with a key from a Kubernetes Secret, so a dump of this table alone is not
    -- enough to use the credentials in it.
    credential_ciphertext bytea,
    credential_nonce      bytea,
    credential_tag        bytea,

    enabled     boolean     NOT NULL DEFAULT true,
    timeout_ms  integer     NOT NULL DEFAULT 20000,

    -- Liveness, written by the prober rather than by a user. Kept in the database rather
    -- than in each replica's memory so that every gateway replica and the dashboard agree
    -- on what is up, and so `tools/list` can be served from here without blocking on a
    -- dead upstream.
    status         text        NOT NULL DEFAULT 'unknown',
    -- The human-readable reason. The brief asks for a failure reason in the dashboard, and
    -- "Unreachable" on its own is the thing it is asking us not to do.
    last_error     text,
    last_probed_at timestamptz,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT mcp_servers_slug_shaped  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
    CONSTRAINT mcp_servers_auth_valid   CHECK (auth_type IN ('none', 'bearer', 'header')),
    CONSTRAINT mcp_servers_status_valid CHECK (status IN ('unknown', 'connected', 'unreachable', 'disabled')),
    CONSTRAINT mcp_servers_timeout_sane CHECK (timeout_ms BETWEEN 1000 AND 120000),

    -- A header credential needs a header name to put it in, and a credential-less server
    -- must not carry a stale one. Expressed as a constraint rather than trusted to the
    -- API layer, because the database is the last place that can still say no.
    CONSTRAINT mcp_servers_header_name_present CHECK (
        (auth_type = 'header' AND auth_header IS NOT NULL) OR
        (auth_type <> 'header' AND auth_header IS NULL)
    ),
    -- The three credential columns are all present or all absent. A row with ciphertext
    -- and no nonce is undecryptable, and would fail at call time rather than at write
    -- time - the worst moment to discover it.
    CONSTRAINT mcp_servers_credential_whole CHECK (
        (credential_ciphertext IS NULL AND credential_nonce IS NULL AND credential_tag IS NULL) OR
        (credential_ciphertext IS NOT NULL AND credential_nonce IS NOT NULL AND credential_tag IS NOT NULL)
    ),
    CONSTRAINT mcp_servers_auth_needs_credential CHECK (
        auth_type = 'none' OR credential_ciphertext IS NOT NULL
    )
);

-- The tool cache. Refreshed by the health prober, read to answer `tools/list`.
--
-- Caching is not an optimisation here, it is what stops one dead upstream from breaking
-- discovery for every other one. A `tools/list` that fanned out live would be as slow as
-- the slowest upstream and would fail entirely when one hung.
CREATE TABLE mcp_tools (
    id            bigserial   PRIMARY KEY,
    server_id     uuid        NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
    -- The name as the upstream reports it.
    name          text        NOT NULL,
    -- The name this gateway exposes: '<slug>__<name>', clamped to 60 characters with a
    -- hash suffix on overflow. Stored rather than computed on read, so the mapping back to
    -- an upstream tool cannot drift from the one that was advertised.
    prefixed_name text        NOT NULL,
    title         text,
    description   text,
    -- jsonb, not json: it is compared and indexed, and jsonb normalises key order so an
    -- upstream reordering its schema does not look like a change.
    input_schema  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    annotations   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    last_seen_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT mcp_tools_server_name_key    UNIQUE (server_id, name),
    CONSTRAINT mcp_tools_prefixed_name_key  UNIQUE (prefixed_name)
);

CREATE INDEX mcp_tools_server_id_idx ON mcp_tools (server_id);
