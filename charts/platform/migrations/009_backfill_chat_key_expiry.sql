-- Give the chat keys that predate migration 008 an expiry, so they cannot be immortal.
--
-- Found by counting rather than by reasoning: after 008 shipped, the table held 28 chat
-- keys and exactly 1 had an `expires_at`. The other 27 were minted before the column
-- existed, so they carry NULL - and NULL means "never expires", which is the right default
-- for a key a human configured into an MCP client and exactly the wrong one here.
--
-- In this cluster the exposure happened to be zero: all 27 had been revoked by the
-- `finally` in `routes/chat.ts`, so none was usable. But that is luck about this deployment,
-- not a property of the schema. Any deployment that upgraded across 008 while a pod was
-- killed mid-chat would hold a chat key that is un-revoked, un-expiring, and valid forever -
-- which is the precise vulnerability 008 was written to close, surviving in the rows that
-- existed when it was written.
--
-- A separate file rather than an edit to 008, because the migration runner's ledger
-- deliberately REFUSES a file whose contents changed after being applied. That is the right
-- behaviour - a silently-edited migration means two databases with the same version number
-- and different schemas - and it means a correction is a new file, which is also more
-- honest: the history shows that 008 was incomplete.

UPDATE api_keys
   SET expires_at = created_at
 WHERE kind = 'chat'
   AND expires_at IS NULL;

-- `expires_at = created_at` rather than `now()` or a computed TTL.
--
-- Every row this touches was created before the deployment that added the column, so it is
-- older than any plausible TTL already - its request is long finished one way or the other.
-- Setting the expiry to the creation time makes it already expired, which means
-- `resolveApiKey` refuses it on the next call and the sweeper revokes it on the next cycle.
--
-- `now()` would be wrong in a way worth naming: it would GRANT these keys a fresh lifetime,
-- extending the window on exactly the credentials this file exists to close. And a computed
-- `created_at + interval` would be arbitrary - there is no reason to keep a key alive for a
-- request that ended days ago.
--
-- Idempotent, so re-running costs nothing: once set, `expires_at IS NULL` no longer matches.
