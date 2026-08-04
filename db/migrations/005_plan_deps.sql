-- Mixed sequential + parallel plan fan-out (issue #20): planner-emitted tasks may
-- declare dependencies on earlier tasks. A pure levelizer (app/waves.ts) assigns
-- each task a 0-based `wave` (longest-path level); the plan-fanout process runs the
-- parallel multi-instance `implement` activity once per wave, in order. Tasks within
-- a wave still run in parallel; a later wave waits for the whole earlier wave.
--
-- `plan_task_deps` records the task DAG (one row per edge), mirroring
-- `pr_dependencies` for PRs — from which per-PR merge ordering already falls out.
-- `plan_tasks.wave` is the levelized wave index (NULL until levelized).

ALTER TABLE plan_tasks ADD COLUMN wave INTEGER;

CREATE TABLE plan_task_deps (
  plan_key            TEXT NOT NULL REFERENCES plans(plan_key),
  task_id             TEXT NOT NULL,   -- the dependent task's slug
  depends_on_task_id  TEXT NOT NULL,   -- the task it waits for
  PRIMARY KEY (plan_key, task_id, depends_on_task_id)
);

CREATE INDEX idx_plan_task_deps_plan ON plan_task_deps(plan_key);
