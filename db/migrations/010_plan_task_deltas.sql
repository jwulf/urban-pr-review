-- Structured scope/impl-change report from implementer agents (D5, issue #55 / #49).
--
-- The implementer result contract (prompts/feature.md) gains an optional `delta`: the machine-
-- readable "I changed the contract / discovered a constraint / this now touches files X / affects
-- tasks A,B" that previously had nowhere to land but PR prose. One row per (plan, task) — upserted,
-- so a worker retry or a post-escalation resume overwrites rather than duplicates. `newly_touches`
-- and `affects_tasks` are JSON-encoded string arrays (feeds D2 conflict-scan + the D4 blackboard).
CREATE TABLE IF NOT EXISTS plan_task_deltas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_key        TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  wave            INTEGER,
  contract_change TEXT,
  newly_touches   TEXT,               -- JSON array of paths, or NULL
  affects_tasks   TEXT,               -- JSON array of task ids, or NULL
  constraint_note TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- One delta per (plan, task): the upsert key. A resume/retry replaces the prior report in place.
CREATE UNIQUE INDEX IF NOT EXISTS ux_plan_task_deltas_task
  ON plan_task_deltas (plan_key, task_id);

-- Read a plan's whole report in write order.
CREATE INDEX IF NOT EXISTS ix_plan_task_deltas_plan
  ON plan_task_deltas (plan_key, id);
