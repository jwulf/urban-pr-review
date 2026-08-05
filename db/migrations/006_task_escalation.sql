-- Implementation-phase escalation (issue #25): give a stuck implementation agent
-- a human-in-the-loop path DURING the fan-out, mirroring the review loop's per-PR
-- escalation but per-TASK.
--
-- The agent opens a DRAFT PR (to preserve its work in git), reports
-- `status = "escalated"` with a `question`, and completes its job promptly. The
-- `plan-fanout` process parks that child at a per-task message catch
-- (`feature-escalation-answered`, correlated on `<plan_key>:<task_id>`); a human
-- answers, the child re-dispatches the SAME task with the answer merged in, and
-- the agent continues on the same branch. Context is externalised to git (the
-- draft PR/branch) + the task row, so a fresh agent on ANY worker machine can
-- resume (see issue #25 "stateless cold re-dispatch").

-- Per-task escalation state. `corr_key` is "<plan_key>:<task_id>" — the message
-- correlation key the process opens its wait subscription on. `draft_pr_key` is
-- the work-preserving draft PR the agent opened before escalating.
ALTER TABLE plan_tasks ADD COLUMN open_question TEXT;
ALTER TABLE plan_tasks ADD COLUMN answer TEXT;
ALTER TABLE plan_tasks ADD COLUMN draft_pr_key TEXT;
ALTER TABLE plan_tasks ADD COLUMN corr_key TEXT;

-- Denormalise the plan's OLDEST still-open task escalation onto the plan row so
-- the generic page runtime (ADR 0042) can bind a single conditional "answer" form
-- to it without a per-child form (which the runtime does not support). The
-- persist worker sets these when it opens an escalation; answering re-points them
-- at the next-oldest open escalation (or clears them). `open_task_corr_key` is the
-- form's correlationKey; `open_task_id` is shown for context.
ALTER TABLE plans ADD COLUMN open_task_escalation_id INTEGER;
ALTER TABLE plans ADD COLUMN open_task_question TEXT;
ALTER TABLE plans ADD COLUMN open_task_corr_key TEXT;
ALTER TABLE plans ADD COLUMN open_task_id TEXT;

-- One row per implementation-phase escalation (the audit trail, mirroring
-- `escalations` for the review loop). `status` is open | answered.
CREATE TABLE plan_escalations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_key      TEXT NOT NULL REFERENCES plans(plan_key),
  task_id       TEXT NOT NULL,             -- the escalating task's slug
  corr_key      TEXT NOT NULL,             -- "<plan_key>:<task_id>"
  question      TEXT NOT NULL,
  answer        TEXT,
  draft_pr_key  TEXT,                        -- draft PR the agent opened to preserve work
  status        TEXT NOT NULL,             -- open | answered
  asked_at      TEXT NOT NULL,
  answered_at   TEXT
);

CREATE INDEX idx_plan_escalations_plan ON plan_escalations(plan_key);
CREATE INDEX idx_plan_escalations_open ON plan_escalations(plan_key, status);
