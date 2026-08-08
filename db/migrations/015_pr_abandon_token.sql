-- Cooperative abandon check (issue #76): a per-PR capability token the running agent curls to learn
-- whether its run was cancelled before it performs a side effect. The abandon state itself is
-- derived from pull_requests.status (set to 'abandoned' by cancelRun); this only adds the token the
-- /hooks/abandon endpoint resolves back to the PR.
ALTER TABLE pull_requests ADD COLUMN abandon_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pull_requests_abandon_token
  ON pull_requests(abandon_token)
  WHERE abandon_token IS NOT NULL;
