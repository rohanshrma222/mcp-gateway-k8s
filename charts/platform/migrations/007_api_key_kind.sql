-- The chat agent needs a key, and the audit log needs to say so without being told.
--
-- Step 8.1 makes the in-dashboard chat agent act as the logged-in user by minting it an
-- API key and having it connect to our own /mcp exactly as Claude Code does. That is the
-- whole point: the agent gets no privileged in-process shortcut, so whatever a user can do
-- in chat is precisely what their own key could do, and the audit row carries the real
-- user rather than a service account.
--
-- But `audit_log.actor` has to distinguish a call that came from chat from one that came
-- from an external client, and the obvious way to do that - a header the chat agent sets,
-- say `X-Urumi-Actor: chat` - is wrong, because headers are written by whoever makes the
-- request. An external client holding a valid key could send that header and have its
-- calls recorded as chat activity, or quietly hide among them. An audit trail a caller can
-- influence is not an audit trail.
--
-- So the actor is derived from the key record instead. The gateway mints the chat key
-- itself and marks it here; `resolveApiKey` reads this column back; and the /mcp route sets
-- `actor` from the resolved principal rather than from anything in the request. A client
-- cannot forge it because it cannot mint a key - issuing one requires a logged-in session,
-- and the value is written server-side at that moment.
--
-- A column rather than a naming convention on `name`, because a convention is a comment
-- that the database does not enforce, and `name` is user-supplied free text: somebody would
-- eventually call a key "chat" and silently acquire the chat actor.

ALTER TABLE api_keys
    ADD COLUMN kind text NOT NULL DEFAULT 'standard';

-- Constrained rather than left as free text. The set is closed and small, and an
-- unrecognised value here would make the audit log ambiguous in exactly the way the column
-- exists to prevent. A CHECK is also cheaper to reason about than an enum type: adding a
-- value later is one migration either way, but a CHECK does not leave a type behind in the
-- schema that outlives the column.
ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_kind_known CHECK (kind IN ('standard', 'chat'));

-- DEFAULT 'standard' means every key issued before this migration - and every key issued
-- through the dashboard afterwards - is correctly a standard key with no backfill needed.
-- The default stays on the column rather than being dropped: `routes/keys.ts` does not
-- mention `kind` at all, and the right behaviour for a key a human asked for is standard.
-- Only the chat path passes it explicitly.

-- Chat keys are short-lived and numerous - one per chat request - while standard keys are
-- few and long-lived. Every query that lists keys for a user is now interested in only one
-- of those populations, so the index carries `kind` and lets the dashboard's list skip the
-- ephemeral ones without reading them.
CREATE INDEX api_keys_user_kind_idx ON api_keys (user_id, kind, created_at DESC);

COMMENT ON COLUMN api_keys.kind IS
    'standard = issued by a human through the dashboard; chat = minted by the gateway for one chat request. Determines audit_log.actor, and is therefore never settable by a client.';
