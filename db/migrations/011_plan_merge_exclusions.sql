-- The merge-exclusion graph (D1, issue #57 / #49).
--
-- A SECOND relationship, distinct from the dispatch-DAG (`plan_task_deps` → waves). Those edges
-- gate *starting* a task; these gate *landing* it: two tasks can run in parallel but touch the same
-- surface, so they can't merge independently (nano-bpm#614: nine slices all appending to
-- engine/tests.rs). Undirected `(task_a, task_b)` pairs, `task_a < task_b` normalised so a pair has
-- exactly one row. `files` is the JSON-encoded overlapping path set; `source` records how the edge
-- was derived (e.g. `file-overlap`). These MUST NEVER enter computeWaves — they order landings only.
CREATE TABLE IF NOT EXISTS plan_merge_exclusions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_key   TEXT NOT NULL,
  task_a     TEXT NOT NULL,
  task_b     TEXT NOT NULL,
  files      TEXT,               -- JSON array of the overlapping paths
  source     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per unordered pair on a plan: the upsert key (a refreshed scan updates files in place).
CREATE UNIQUE INDEX IF NOT EXISTS ux_plan_merge_exclusions_pair
  ON plan_merge_exclusions (plan_key, task_a, task_b);

-- Read a plan's whole exclusion graph.
CREATE INDEX IF NOT EXISTS ix_plan_merge_exclusions_plan
  ON plan_merge_exclusions (plan_key, id);
