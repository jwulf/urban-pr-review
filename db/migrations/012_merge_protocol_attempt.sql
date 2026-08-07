-- Merge-protocol liveness (D9). The frugal-CI fresh-head-run remedy is one-shot per landing
-- attempt, not per PR lifetime: a rebase creates a new head commit and may need a new synthetic
-- `pull_request` run even if an earlier head was already nudged.
ALTER TABLE pull_requests ADD COLUMN fresh_head_run_head TEXT;
