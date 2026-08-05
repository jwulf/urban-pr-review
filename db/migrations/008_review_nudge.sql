-- Review-wait liveness. A PR parked in `waiting_review` blocks on a *fresh* Copilot review
-- arriving. Copilot does not spontaneously re-review a round with no new commit, and it
-- routinely dismisses a re-request (`review_request_removed`) — so without an active nudge the
-- loop can hang indefinitely at the `wait-review` catch (observed: three merlin convergence
-- processes stalled ~22h). The poller now re-requests Copilot on a waiting PR that has no
-- pending Copilot reviewer; `last_nudge_at` records when it last did so, so the nudge is
-- throttled to one attempt per cooldown window (NANO_PR_REVIEW_NUDGE_MINUTES) rather than
-- hammering the reviewers API on every poll tick. NULL = never nudged.
ALTER TABLE pull_requests ADD COLUMN last_nudge_at TEXT;  -- ISO ts of the last Copilot re-request nudge; NULL when never nudged
