-- An expiry for the chat agent's ephemeral keys.
--
-- Step 8.1 mints a key per chat request and revokes it in a `finally`, which bounds the
-- key's life to one request and is tighter than any TTL. The gap it named honestly: if the
-- pod is killed mid-chat - a rollout, an OOM, a node eviction - the `finally` never runs
-- and a valid credential is left in the database with nothing to clean it up.
--
-- This column closes that, and the important part is WHERE it is enforced. The expiry is
-- checked in `resolveApiKey`, on the path every single /mcp call already takes, so an
-- orphaned key stops working the moment it expires whether or not any background job is
-- alive. A sweeper also runs, but only to tidy rows - if it were the only enforcement then
-- a crashed sweeper would silently restore the vulnerability, and 6.1 settled that a
-- control which can be skipped without anyone noticing is not a control.
--
-- NULLABLE, and that is the design rather than laziness. A key a human asked for through
-- the dashboard has no natural expiry: it is configured into an external MCP client and
-- should keep working until somebody revokes it. Making every key expire would be a
-- different product decision - a reasonable one, and a surprising one to inflict on a
-- user's Claude Code config a fortnight after they set it up. So NULL means "never
-- expires", standard keys carry NULL, and only the chat path sets a value.

ALTER TABLE api_keys
    ADD COLUMN expires_at timestamptz;

COMMENT ON COLUMN api_keys.expires_at IS
    'NULL means the key never expires, which is the case for every key issued through the dashboard. Chat keys carry a timestamp. Enforced in resolveApiKey on every call, not only by the sweeper.';

-- The sweeper's query is "chat keys that have expired and are not yet revoked", so the
-- index carries exactly that shape. Partial, on `revoked_at IS NULL`, because the rows it
-- needs are a shrinking minority: every chat request creates a key and almost all of them
-- are revoked within a second, so an index over all of them would be mostly dead weight.
--
-- This is the same reasoning as migration 006's composite audit index, arrived at the same
-- way: by writing the query first and then indexing it, rather than indexing the column and
-- hoping.
CREATE INDEX api_keys_expiry_sweep_idx
    ON api_keys (expires_at)
    WHERE revoked_at IS NULL AND expires_at IS NOT NULL;
