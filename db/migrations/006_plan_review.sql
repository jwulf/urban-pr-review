-- Adversarial plan review (issue: gate the plan before fan-out). After the `senior:plan`
-- agent emits a plan and `record-plan` levelizes it, an INDEPENDENT `senior:plan-review`
-- agent adversarially critiques the decomposition and sequencing BEFORE any wave dispatches.
-- On a rejecting verdict the planner revises (bounded rounds); on approval (or once the round
-- cap is hit) the wave loop proceeds. The plan is the highest-leverage artifact in the fleet —
-- a wrong decomposition or a mis-placed dependency dooms every downstream PR — so it gets the
-- same falsification treatment the PRs themselves get.
--
-- `plan_reviews` is the append-only audit log: one row per review round, with the verdict and
-- the reviewer's findings. The current round is derived from the row count, so the loop needs
-- no counter variable.

CREATE TABLE plan_reviews (
  plan_key    TEXT NOT NULL REFERENCES plans(plan_key),
  round       INTEGER NOT NULL,           -- 0-based review round
  approved    INTEGER NOT NULL,           -- 1 = reviewer approved, 0 = rejected (revise)
  findings    TEXT,                       -- the reviewer's critique (drives the planner's revision)
  created_at  TEXT NOT NULL,
  PRIMARY KEY (plan_key, round)
);

CREATE INDEX idx_plan_reviews_plan ON plan_reviews(plan_key);
