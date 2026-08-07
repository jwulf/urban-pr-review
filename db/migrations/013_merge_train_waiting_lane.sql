-- D6 merge-train lane serialization.
--
-- Adds the durable meaning of pull_requests.status = 'waiting_lane': a converged PR that is green
-- but parked behind the current head of its D2 merge-exclusion lane. SQLite has no status enum in
-- this schema, so no column shape changes are required; the existing idx_pr_status covers polling.
SELECT 1;
