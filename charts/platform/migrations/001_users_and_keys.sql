-- 001  Identity: who may use the gateway, and the keys they use to prove it.
--
-- Two subjects exist in this system and they authenticate differently. A human signs in
-- to the dashboard with a password and gets a short-lived session cookie. A machine - an
-- MCP client such as Claude Code - presents a long-lived API key. Both resolve to a row
-- in `users`, which is what makes a single audit trail possible: every action has one
-- kind of actor behind it, however it arrived.

CREATE TABLE users (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text        NOT NULL,
    -- argon2id, produced by the gateway. The column is deliberately named for the fact
    -- that it is a hash, so a future reader cannot mistake it for a reversible field.
    -- Length is unconstrained because an argon2 encoded string carries its own
    -- parameters, and those parameters are expected to change as hardware does.
    password_hash text        NOT NULL,
    role          text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- Soft disable rather than DELETE. Removing a user would orphan their audit history,
    -- and an audit log that loses rows when someone leaves the company is not an audit
    -- log. See 003.
    disabled_at   timestamptz,

    -- A CHECK against a fixed list rather than a native enum type. Both constrain the
    -- same way, but adding a value to a Postgres enum is a schema change that cannot run
    -- inside the same transaction as its use in older versions, whereas editing a CHECK
    -- is an ordinary ALTER. The constraint is also visible in \d output, which an enum's
    -- membership is not.
    CONSTRAINT users_role_valid CHECK (role IN ('admin', 'member'))
);

-- Case-insensitive uniqueness. Addresses are not case-sensitive in practice, and without
-- this, Alice@example.com and alice@example.com are two accounts with one owner - which
-- is both a support problem and an authorisation bypass waiting to happen.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE api_keys (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The public half, which appears in the key the user holds and in log lines. Safe to
    -- display, so the dashboard can list keys without ever seeing a secret.
    key_id        text        NOT NULL UNIQUE,
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name          text        NOT NULL,
    -- sha256 of the secret half, hex encoded. NOT argon2, and the difference is
    -- deliberate: a password is low-entropy and human-chosen, so it needs a slow hash to
    -- survive an offline attack. An API key secret is 32 bytes of CSPRNG output, so
    -- there is nothing to brute-force, and a slow hash on the hot path of every single
    -- MCP call would be a self-inflicted denial of service. Fixed 64 chars, checked.
    secret_sha256 text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- Written on use. Deliberately not an exact counter: that would mean a write on every
    -- call purely for curiosity's sake, and the audit log already records every call.
    last_used_at  timestamptz,
    -- Revocation is a timestamp, not a DELETE, for the same reason as users.disabled_at:
    -- the key's id has to stay resolvable for its audit rows to mean anything.
    revoked_at    timestamptz,

    CONSTRAINT api_keys_sha256_shaped CHECK (secret_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);

-- The lookup on the hot path: every authenticated MCP request resolves a presented key
-- by its hash. Partial, covering only live keys, so revoked keys neither slow the lookup
-- nor enlarge the index.
CREATE INDEX api_keys_active_sha256_idx ON api_keys (secret_sha256) WHERE revoked_at IS NULL;
