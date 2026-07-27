-- urban-pr-review schema (SPEC §7). One row per PR under convergence, its rounds,
-- and any escalations raised mid-convergence.

CREATE TABLE IF NOT EXISTS pull_requests (
  pr_key         TEXT PRIMARY KEY,          -- "<owner>/<repo>#<number>"
  repo           TEXT NOT NULL,             -- "<owner>/<repo>"
  number         INTEGER NOT NULL,
  url            TEXT NOT NULL,
  title          TEXT,                      -- fetched from GitHub (optional)
  status         TEXT NOT NULL,             -- converging | waiting_review | escalated | converged | abandoned
  current_round  INTEGER NOT NULL DEFAULT 0,
  process_key    TEXT,                      -- engine process-instance key
  waiting_since  TEXT,                      -- ISO ts we began waiting for a review (poller cursor)
  last_review_id INTEGER,                   -- last GitHub review id we reacted to
  outcome        TEXT,                      -- final summary
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  converged_at   TEXT
);

CREATE TABLE IF NOT EXISTS rounds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key     TEXT NOT NULL REFERENCES pull_requests(pr_key),
  round_no   INTEGER NOT NULL,
  status     TEXT,                          -- converged | addressed | needs_input | blocked
  summary    TEXT,
  started_at TEXT NOT NULL,
  ended_at   TEXT
);

CREATE TABLE IF NOT EXISTS escalations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key      TEXT NOT NULL REFERENCES pull_requests(pr_key),
  round_no    INTEGER NOT NULL,
  kind        TEXT NOT NULL,                -- question | blocker
  question    TEXT NOT NULL,
  answer      TEXT,
  status      TEXT NOT NULL,                -- open | answered
  asked_at    TEXT NOT NULL,
  answered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pr_status ON pull_requests(status);
CREATE INDEX IF NOT EXISTS idx_rounds_pr ON rounds(pr_key);
CREATE INDEX IF NOT EXISTS idx_esc_pr ON escalations(pr_key);
CREATE INDEX IF NOT EXISTS idx_esc_open ON escalations(pr_key, status);
