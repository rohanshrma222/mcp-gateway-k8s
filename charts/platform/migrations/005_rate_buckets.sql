-- 005  Per-key rate limiting. Stand-out area #7.
--
-- In Postgres rather than Redis, and that is a deliberate rejection. Redis would be the
-- usual answer and would mean one more StatefulSet, one more Secret, one more failure
-- mode and one more thing to justify, to hold a counter per API key. The gateway already
-- has a transactional database one hop away; a token bucket is a row with two columns and
-- an atomic UPDATE. If the call rate ever outgrows that, the answer is visible in the
-- /metrics histogram rather than guessed at now.

CREATE TABLE rate_buckets (
    -- One bucket per key, so the key itself is the primary key. No surrogate id: there is
    -- nothing to reference this row by.
    api_key_id  uuid        PRIMARY KEY REFERENCES api_keys (id) ON DELETE CASCADE,

    -- Fractional tokens, because refill is computed from elapsed time and rounding down to
    -- an integer on every request would leak allowance - at high rates a client could be
    -- throttled below its configured limit purely by truncation.
    tokens      double precision NOT NULL,
    updated_at  timestamptz      NOT NULL DEFAULT now(),

    CONSTRAINT rate_buckets_tokens_sane CHECK (tokens >= 0)
);

-- The whole algorithm is one statement, and it has to be, because correctness here is
-- entirely about atomicity:
--
--   INSERT INTO rate_buckets (api_key_id, tokens)
--   VALUES ($1, $2 - 1)
--   ON CONFLICT (api_key_id) DO UPDATE SET
--     tokens = LEAST($2, rate_buckets.tokens
--                        + EXTRACT(EPOCH FROM (now() - rate_buckets.updated_at)) * $3) - 1,
--     updated_at = now()
--   WHERE rate_buckets.tokens
--         + EXTRACT(EPOCH FROM (now() - rate_buckets.updated_at)) * $3 >= 1
--   RETURNING tokens;
--
-- Refill is computed from elapsed time rather than by a background job, so there is no
-- timer to run, nothing to catch up after a restart, and no clock for a second replica to
-- disagree with. Zero rows returned means the bucket was empty: that is the 429, and the
-- WHERE clause is what makes the check and the decrement a single atomic act. Read-then-
-- write in application code would let two concurrent requests both observe one remaining
-- token and both proceed, which is exactly the bug a rate limiter must not have - and it
-- would do so only under load, which is when it matters.
--
-- Because the state is a row rather than per-process memory, two gateway replicas share
-- one limit instead of each granting the full allowance. The limit is a property of the
-- key, not of which pod answered.
