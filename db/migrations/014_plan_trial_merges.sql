-- D3 trial-merge integration gate audit (issue #69).
CREATE TABLE IF NOT EXISTS plan_trial_merges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_key TEXT NOT NULL,
  wave INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL CHECK (result IN ('clean', 'merge-conflict', 'suite-failed')),
  heads TEXT,
  conflicts TEXT,
  failing TEXT,
  summary TEXT,
  job_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plan_trial_merges_plan_wave
  ON plan_trial_merges(plan_key, wave, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_trial_merges_plan_job
  ON plan_trial_merges(plan_key, job_key)
  WHERE job_key IS NOT NULL;
