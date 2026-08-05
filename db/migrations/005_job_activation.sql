-- Job-activation visibility. The `converging` status conflates two distinct engine
-- states of the `senior:pr-review` job the process parks at (the `review-round`
-- service task): the job may be CREATED but not yet activated (no agent has picked
-- it up — "waiting for activation"), or activated/leased to a worker (an agent is
-- actively working the round). The engine tracks this (JobState::Created vs
-- ::Activated) but the Camunda-8 `/v2/jobs/search` wire API collapses Activated ->
-- CREATED (Camunda's JobStateEnum has no ACTIVATED value), so activation is read
-- off the standard `worker` + `deadline` fields: an activated job carries the
-- leasing worker's name and a lock deadline; a merely-created one carries neither.
--
-- The review-ready poller writes these from a `/v2/jobs/search` pass so the pages
-- surface can show "agent working" vs "queued (awaiting an agent)" — and, via the
-- lease deadline, a stalled/lost agent whose lock is lapsing.
ALTER TABLE pull_requests ADD COLUMN active_worker TEXT;  -- leasing worker's name while an agent is working the round; NULL when queued/not at review-round
ALTER TABLE pull_requests ADD COLUMN lease_until TEXT;    -- ISO ts the current activation lease expires (job deadline); NULL when not activated
