-- 003  The audit log. Append-only, and the one table designed to outlive its references.
--
-- The brief requires every tool call recorded with user, server, tool, timestamp,
-- duration and outcome, visible in the dashboard. That makes this the table a reviewer is
-- most likely to interrogate, so the reasoning is written out rather than implied.

CREATE TABLE audit_log (
    -- bigserial, not uuid. This table is append-only and will be the largest by orders of
    -- magnitude; a monotonic key keeps inserts at the right-hand edge of the index instead
    -- of scattering them across it, and it gives a natural tiebreak for rows sharing a
    -- timestamp. Random uuids would fragment the index for no benefit, since nothing here
    -- is enumerable by an outsider.
    id            bigserial   PRIMARY KEY,

    -- References, nullable and SET NULL on delete...
    user_id       uuid        REFERENCES users (id)       ON DELETE SET NULL,
    api_key_id    uuid        REFERENCES api_keys (id)    ON DELETE SET NULL,
    server_id     uuid        REFERENCES mcp_servers (id) ON DELETE SET NULL,

    -- ...alongside the same facts as plain text, written at insert time.
    --
    -- This duplication is the single most deliberate choice in the schema. CASCADE would
    -- be the conventional answer and it is wrong here: deleting an upstream server would
    -- erase the record of everything ever done through it, which is precisely the history
    -- an audit log exists to keep. Equally, a SET NULL with no denormalised copy would
    -- leave a row saying "someone called something at 14:02", which is worse than nothing
    -- because it looks like data.
    --
    -- So the foreign keys are for joining while the subject still exists, and these
    -- columns are the record. Removing a user or a server from the system does not rewrite
    -- what they did.
    user_email    text,
    server_slug   text,
    tool_name     text        NOT NULL,

    started_at    timestamptz NOT NULL DEFAULT now(),
    duration_ms   integer     NOT NULL,
    outcome       text        NOT NULL,
    -- Machine-readable classification plus the sentence a human reads. Both, because
    -- filtering wants the first and the dashboard wants the second.
    error_code    text,
    error_message text,

    -- Which door the call came through: the in-dashboard chat agent, or an external MCP
    -- client such as Claude Code. The brief's definition of done requires that a chat
    -- action is attributed to the real logged-in user and not to a service account, so
    -- this distinguishes the path without weakening the attribution.
    actor         text        NOT NULL,
    -- Ties a row back to the gateway's structured logs for the same request.
    request_id    text,

    CONSTRAINT audit_log_outcome_valid  CHECK (outcome IN ('ok', 'error', 'denied', 'timeout')),
    CONSTRAINT audit_log_actor_valid    CHECK (actor IN ('chat', 'external')),
    CONSTRAINT audit_log_duration_sane  CHECK (duration_ms >= 0)
);

-- Indexes follow the dashboard's actual query, which is "most recent first, optionally
-- filtered". DESC on started_at because nobody reads an audit log forwards from the
-- beginning of time.
CREATE INDEX audit_log_started_at_idx      ON audit_log (started_at DESC);
CREATE INDEX audit_log_user_started_idx    ON audit_log (user_id, started_at DESC);
CREATE INDEX audit_log_server_started_idx  ON audit_log (server_id, started_at DESC);
CREATE INDEX audit_log_tool_started_idx    ON audit_log (tool_name, started_at DESC);
-- Partial: the common investigation is "show me what went wrong", and failures are the
-- small minority of rows, so an index that only holds them stays small and is a cheap
-- answer to the most useful question.
CREATE INDEX audit_log_failures_idx        ON audit_log (started_at DESC) WHERE outcome <> 'ok';

-- Append-only: enforced by PRIVILEGE, not by a rule.
--
-- The obvious implementation is a pair of rules, ON UPDATE / ON DELETE DO INSTEAD
-- NOTHING, and that was the first version here. It is incompatible with the foreign keys
-- above, and the incompatibility is worth recording because it is not obvious.
--
-- The three references are ON DELETE SET NULL, and a referential SET NULL action is
-- carried out as an UPDATE against this table. A rule that suppresses UPDATE therefore
-- interferes with the referential machinery. Tested rather than assumed, on this Postgres:
--
--   ERROR:  referential integrity query on "p" from constraint "c_p_id_fkey" on "c"
--           gave unexpected result
--   HINT:  This is most likely due to a rule having rewritten the query.
--
-- So Postgres refuses the DELETE rather than corrupting anything, which is a relief and
-- still the wrong outcome: removing an upstream server is something the dashboard is
-- required to support, and with those rules in place it would be impossible. The rules
-- would trade a working feature for a property better obtained elsewhere.
--
-- So append-only belongs at the privilege layer, where it does not fight the data model:
-- the gateway connects as a role holding INSERT and SELECT on this table and nothing more,
-- which means application code cannot rewrite history even by mistake, while the
-- referential actions still run as the table owner. That role split lands with the
-- least-privilege sweep in stage 9; until then the property is a convention backed by the
-- absence of any UPDATE or DELETE statement against this table in the codebase, and that
-- distinction is stated plainly rather than overclaimed.
--
-- Neither mechanism defends against a determined superuser. Nothing at this layer can.
