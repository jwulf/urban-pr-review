-- Denormalise the currently-open escalation onto the PR row so the generic page
-- runtime (ADR 0042) can bind a conditional "answer" form to it without a join:
-- the form is shown when `open_escalation_id` is set and prints
-- `open_escalation_question`. The persist-escalation worker sets these when it
-- opens an escalation, and answering (or finalising) clears them.

ALTER TABLE pull_requests ADD COLUMN open_escalation_id INTEGER;
ALTER TABLE pull_requests ADD COLUMN open_escalation_question TEXT;
