-- Merge stage (SPEC §11). Once a PR converges, a separate `merge-loop` process drives it to
-- land: it waits for any declared cross-PR dependencies to merge first, then for the PR to
-- become mergeable (checks green, no conflicts), then merges it — directly or via the repo's
-- merge queue — escalating to a human when it is blocked. These columns/tables record that
-- stage alongside the convergence stage already captured by 001_init.sql.

-- When the PR actually landed (NULL until merged). `outcome` (001) still holds the convergence
-- summary; a separate timestamp keeps "converged" and "merged" distinguishable on the row.
ALTER TABLE pull_requests ADD COLUMN merged_at TEXT;

-- Cross-PR merge dependencies: this PR must not merge until every `depends_on_key` PR has
-- merged. Declared at submit time (a `dependsOn` field on the submit endpoints and/or a
-- `Depends-on: owner/repo#N` line in the PR body). Re-submitting a PR replaces its dep set.
CREATE TABLE IF NOT EXISTS pr_dependencies (
  pr_key         TEXT NOT NULL,             -- the dependent PR ("<owner>/<repo>#<number>")
  depends_on_key TEXT NOT NULL,             -- the PR it waits on ("<owner>/<repo>#<number>")
  created_at     TEXT NOT NULL,
  PRIMARY KEY (pr_key, depends_on_key)
);

-- Audit trail of merge attempts, so a human can see how a PR landed (or why it stalled)
-- without re-running anything — the merge-stage analogue of `rounds`.
CREATE TABLE IF NOT EXISTS merges (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key   TEXT NOT NULL REFERENCES pull_requests(pr_key),
  outcome  TEXT NOT NULL,                   -- merged | queued | blocked
  method   TEXT,                            -- squash | merge | rebase | queue
  detail   TEXT,                            -- gh/API message (success line or error)
  at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deps_pr ON pr_dependencies(pr_key);
CREATE INDEX IF NOT EXISTS idx_deps_on ON pr_dependencies(depends_on_key);
CREATE INDEX IF NOT EXISTS idx_merges_pr ON merges(pr_key);
