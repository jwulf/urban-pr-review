-- Epic coordination blackboard — Tier 1 (issues #51 / #49 D4).
--
-- A per-plan advisory shared store that implementer agents READ on dispatch and WRITE to
-- (file-claims, constraint/scope changes), so parallel siblings in a wave can coordinate
-- without a human relay. Before this, the only structured channel was task->human escalation;
-- all sibling coordination ("task U now also touches state.rs") lived in PR/issue prose the
-- planner and other agents could not act on (retro: Magikcraft/nano-bpm#614).
--
-- Deliberately kept OUT of process/engine state: it is *advisory knowledge*, never gates a
-- sequence flow, and is read fresh (so it need not be replay-deterministic). Control-flow stays
-- in the BPMN; this is a shared scratchpad.
--
-- Delivery vs use: the plan process seeds a rendered coordination brief (including THIS plan's
-- capability URL) into `appendPrompt`; the c8ctl-nano harness forwards that prompt verbatim, so
-- it needs no change. The agent then talks to the endpoint DIRECTLY as a side-channel — a
-- different endpoint from the activation/completion channel.

-- Per-plan capability token: the unguessable credential baked into the blackboard URL handed to
-- agents (the URL *is* the credential). Minted at plan start; `/hooks/blackboard` maps it back to
-- this plan and scopes reads/writes to it. NULL for plans created before this migration.
ALTER TABLE plans ADD COLUMN blackboard_token TEXT;

CREATE TABLE plan_blackboard (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_key    TEXT NOT NULL REFERENCES plans(plan_key),
  author_task TEXT NOT NULL DEFAULT 'system', -- the writing task's slug (or 'system' for host writes)
  kind        TEXT NOT NULL DEFAULT 'note',    -- file-claim | constraint-change | scope-change | note
  files       TEXT,                            -- JSON array of repo-relative paths (nullable; feeds D2)
  body        TEXT NOT NULL,                   -- the human/agent-readable note
  wave        INTEGER,                         -- optional wave index the writer was dispatched in
  dedupe_key  TEXT,                            -- idempotency key (see the unique index below)
  created_at  TEXT NOT NULL
);

-- Idempotent write-back: the engine may re-activate a job on retry, so re-POSTing the same entry
-- (same author + stable dedupe_key) must collapse to one row. Partial index so the common
-- dedupe-less note (NULL dedupe_key) is unconstrained and always appends.
CREATE UNIQUE INDEX ux_plan_blackboard_dedupe
  ON plan_blackboard (plan_key, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- List a plan's entries in write order (id asc), and map a capability token back to its plan.
CREATE INDEX ix_plan_blackboard_plan ON plan_blackboard (plan_key, id);
CREATE INDEX ix_plans_blackboard_token ON plans (blackboard_token);
