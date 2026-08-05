-- Idempotency key for record-plan-review (issue: gate the plan before fan-out).
--
-- The review round is derived from `count(plan_reviews)` (no counter variable). That derivation
-- is NOT idempotent under Zeebe job retries: if the `pr.record-plan-review` job crashes or its
-- deadline lapses AFTER the row insert but BEFORE the job completes, the engine re-activates the
-- SAME job (stable `jobKey`). A naive retry would insert a SECOND row for a fresh round index,
-- inflating the count and tripping `reviewExhausted` early — proceeding to fan-out with fewer
-- review rounds than intended.
--
-- Recording the engine `jobKey` that wrote each row lets the worker detect a retry and reuse the
-- already-recorded verdict instead of appending a duplicate. Pre-existing rows keep `job_key`
-- NULL; SQLite treats NULLs as distinct in a UNIQUE index, so they never collide.
ALTER TABLE plan_reviews ADD COLUMN job_key TEXT;
CREATE UNIQUE INDEX idx_plan_reviews_job ON plan_reviews(plan_key, job_key);
