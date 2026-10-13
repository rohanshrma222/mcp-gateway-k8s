-- 004  Per-tool permissions. Stand-out area #2.
--
-- The requirement is that a restricted tool is both hidden from `tools/list` AND rejected
-- on a direct call. Hiding alone is not a permission system - it is a UI convenience that
-- an attacker skips by guessing the name - so both paths consult this table.

CREATE TABLE tool_permissions (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- A rule applies either to a role (every member) or to one user. Two nullable columns
    -- with a constraint saying exactly one is set, rather than a single polymorphic
    -- "subject" text column: this way the user reference is a real foreign key that
    -- cascades, instead of a string that silently outlives the account it names.
    role         text,
    user_id      uuid        REFERENCES users (id) ON DELETE CASCADE,

    -- NULL server_id means "every server"; NULL tool_name means "every tool on that
    -- server". So a single row can express "members may not write anywhere", and a more
    -- specific row can carve out an exception.
    server_id    uuid        REFERENCES mcp_servers (id) ON DELETE CASCADE,
    tool_name    text,

    effect       text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tool_permissions_effect_valid CHECK (effect IN ('allow', 'deny')),
    CONSTRAINT tool_permissions_role_valid   CHECK (role IS NULL OR role IN ('admin', 'member')),
    -- Exactly one subject. `<>` on two booleans is XOR.
    CONSTRAINT tool_permissions_one_subject  CHECK ((role IS NULL) <> (user_id IS NULL)),
    -- A tool name without a server is meaningless, because tool names are only unique
    -- within a server - two upstreams deliberately both expose `list_products` in this
    -- project, which is the whole point of the collision demo.
    CONSTRAINT tool_permissions_tool_needs_server CHECK (tool_name IS NULL OR server_id IS NOT NULL)
);

-- Uniqueness has to treat NULL as a value here, because NULL means "all" rather than
-- "unknown" in these columns, and the default UNIQUE treats two NULLs as distinct - which
-- would allow two contradictory "all servers" rules for the same subject. NULLS NOT
-- DISTINCT says what is meant.
CREATE UNIQUE INDEX tool_permissions_role_scope_key
    ON tool_permissions (role, server_id, tool_name) NULLS NOT DISTINCT
    WHERE role IS NOT NULL;

CREATE UNIQUE INDEX tool_permissions_user_scope_key
    ON tool_permissions (user_id, server_id, tool_name) NULLS NOT DISTINCT
    WHERE user_id IS NOT NULL;

CREATE INDEX tool_permissions_user_id_idx   ON tool_permissions (user_id)   WHERE user_id IS NOT NULL;
CREATE INDEX tool_permissions_server_id_idx ON tool_permissions (server_id) WHERE server_id IS NOT NULL;

-- Resolution order, implemented in the gateway and written here so the table and the code
-- cannot disagree about intent:
--
--   1. deny for this user, most specific scope first   (tool > server > global)
--   2. allow for this user, most specific scope first
--   3. deny for this user's role, most specific first
--   4. allow for this user's role, most specific first
--   5. default
--
-- Deny beats allow at equal specificity, and a more specific rule beats a broader one.
-- The default is the important part: it is **deny** for anything not explicitly allowed,
-- so a newly registered upstream is unusable by members until an admin says otherwise.
-- Default-allow would mean adding a server silently widens everyone's access, which is
-- the same mistake as a NetworkPolicy that permits what it has not considered.
