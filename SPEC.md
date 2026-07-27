# urban-pr-review — specification (draft)

A Nano **Urban app** that drives GitHub pull requests to convergence against an
automated reviewer (e.g. GitHub Copilot's PR review), one durable, multi-round
loop per PR. The reviewer-agent is **decoupled**: from this app's point of view
it is just a BPMN service task with a `taskType` and a job payload. Whether a
Copilot instance (via `c8ctl nano recruit`/`work`), a script, or anything else
services that job is entirely the worker's concern — this app never names it.

Status: **design draft** — decisions below are agreed; domain model + web
surface are proposed and open for adjustment.

---

## 1. Goal

- Submit a PR (web form or webhook) → the app runs a durable convergence loop:
  address the reviewer's comments, push, re-request review, **wait** for the
  next review, repeat until the latest review has nothing actionable.
- A web UI shows PRs **currently converging** (collapsible detail) and
  **historical converged** PRs, with their round-by-round data.
- Persist everything in **SQLite**.
- Handle **escalation**: if the agent needs to ask a question mid-round, pause
  and let a human answer, then resume.

## 2. Architecture (decoupled)

```
          submit (form / webhook)
                     │
                     ▼
            ┌───────────────────┐        review-ready (msg)      ┌──────────┐
            │  convergence-loop │◀───────────────────────────────│  poller  │
            │      (BPMN)       │        escalation-answered (msg)└────┬─────┘
            └─────────┬─────────┘◀───────────────┐                    │ polls
                      │ pr-review.round job       │ answer POST        │ GitHub
                      ▼                           │                    ▼
            ┌───────────────────┐          ┌──────┴───────┐     ┌────────────┐
            │  decoupled agent  │          │   web UI +   │     │   SQLite   │
            │ (c8ctl nano work) │          │  API routes  │────▶│ (app.db)   │
            └───────────────────┘          └──────────────┘     └────────────┘
```

- **Engine**: embedded Nano (the Urban app deploys its BPMN + runs the loop).
- **Agent**: external worker subscribed to `pr-review.round`. Short jobs — one
  round then return. It never blocks on the wait.
- **BPMN owns the durable wait** between rounds (message catch events), so
  agent worker slots and job timeouts are never held hostage to Copilot's reply
  latency.
- **Poller**: an in-app background loop that watches waiting PRs and publishes
  the `review-ready` message when a new review lands (no GitHub webhook needed;
  works behind NAT).

## 3. Repository layout

```
urban-pr-review/
  nano.app.json               # manifest (ADR 0027): sqlite data, domain types, submit webhook trigger
  main.ts                     # Deno entrypoint: deploy + start workers + Deno.serve (UI, API, poller)
  deno.json
  public/                     # custom web UI (no built-in surface fits a PR list)
    index.html
    app.js
    style.css
  resources/
    processes/
      convergence-loop.bpmn   # the durable convergence process
  db/
    migrations/
      001_init.sql            # sqlite schema
  prompts/
    review-round.md           # agent instructions asset (injected into job data)
  components/
    review-round.json         # Zeebe element template for the pr-review.round service task
  SPEC.md                     # this document
  README.md
```

## 4. Convergence process (`convergence-loop.bpmn`)

Correlation key for all messages: **`prKey = "<owner>/<repo>#<number>"`** — stable,
known at submit time, carried as a process variable and stored on the DB row.

```
(start: pr-submitted)                      vars in: { repo, prNumber, prUrl, prKey }
      │
      ▼
[Register PR & load prompt]  (script/handler)   → insert DB row; read prompts/review-round.md
      │                                            set prompt, round = 1
      ▼
┌──▶ [Review round]  (service task, taskType: pr-review.round)
│         in : prUrl, repo, prNumber, prompt, round, answer?
│         out: status, summary, question?
│         │
│         ▼
│    <gateway: status>
│      ├── converged  → [Mark converged] → (end: converged)
│      │
│      ├── addressed  → [Wait: review-ready]  (msg catch, key = prKey)
│      │                     → round++ ──────────────────────────────┐
│      │                                                             │
│      └── needs_input     [Record escalation]                       │
│          or blocked  →   (kind = question | blocker)               │
│                          → [Wait: escalation-answered] (msg catch) │
│                          → set answer ──────────────────────────────┤
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

Both `needs_input` (the agent has a question) and `blocked` (the agent is stuck
on something external — auth, a failing push, a missing secret) route to the
**same escalation path**: record it, sleep at `escalation-answered`, then retry
the same round with the human's `answer`. They differ only by escalation `kind`,
which the UI uses to label the card. Neither ends the run — a human always gets
a chance to unblock and resume.

Guard: before each Review round, if round > MAX_ROUNDS → force an escalation
("not converged after N rounds") so a human decides, rather than looping forever.
```

Notes:
- On `addressed`, the agent has **already** re-requested review as part of its
  round, so the process just sleeps at `review-ready`.
- On `needs_input`, the same `round` is retried after the answer (the answer is
  added to the agent's context; the round number does not advance).

## 5. Agent job contract (`pr-review.round`)

**Input** (`job.variables`):
| var | type | notes |
|---|---|---|
| `prUrl` | string | canonical PR URL |
| `repo` | string | `owner/name` |
| `prNumber` | int | |
| `prompt` | string | the full instructions text (from `prompts/review-round.md`) |
| `round` | int | 1-based round counter |
| `answer` | string? | present only when resuming from an escalation |

**Output** (job result variables):
| var | type | notes |
|---|---|---|
| `status` | enum | `converged` \| `addressed` \| `needs_input` \| `blocked` |
| `summary` | string | human-readable account of what the round did |
| `question` | string? | required when `status = needs_input` or `blocked` — the question/blocker text a human must resolve |

The agent is responsible, within a round, for: reading the latest review,
triaging, editing/replying/pushing, and (when `addressed`) re-requesting review.

### Workspace isolation (host mode)

Workspace isolation is the **worker harness's** responsibility, not this app's and
not the prompt's. The `c8ctl nano work` host-git provisioning (frozen v1 envelope)
gives **each job its own `mkdtemp` run-dir + fresh clone**, runs the agent with
`cwd` set to it (`AGENT_WORKSPACE`/`REPO_URL`/`REPO_BRANCH`/`REPO_REF` env), and
**reaps that run-dir when the job ends**. So multiple agents on one host do **not**
collide even in host mode — the isolation lives below the agent.

Consequences the prompt (`prompts/review-round.md`) encodes:
- The agent works only inside its provided `cwd`; it must **not** re-clone or create
  a separate `git worktree`, and must not touch global/host state.
- The agent **cleans up anything it creates outside the commit** before returning
  (worktrees, scratch branches/clones, temp files), so host mode does not leak.
- The harness checks out the PR's **existing head branch** and pushes back to it
  (no new branch/PR). Provisioning the *existing* branch requires the head branch
  name — see §12 (open: whether the app passes `headBranch` in the job payload or
  the `c8ctl` integration resolves it from `prNumber`).

## 6. Signals

| message | correlationKey | published by | payload |
|---|---|---|---|
| `pr-submitted` | — (start) | submit route/webhook | `{repo, prNumber, prUrl, prKey}` |
| `review-ready` | `prKey` | **poller** | `{reviewId, reviewState, submittedAt}` |
| `escalation-answered` | `prKey` | UI answer route | `{answer, escalationId}` |

## 7. Domain model (SQLite — `db/migrations/001_init.sql`) — PROPOSED

```sql
CREATE TABLE pull_requests (
  pr_key           TEXT PRIMARY KEY,          -- "<owner>/<repo>#<number>"
  repo             TEXT NOT NULL,             -- "<owner>/<repo>"
  number           INTEGER NOT NULL,
  url              TEXT NOT NULL,
  title            TEXT,                       -- fetched from GitHub
  status           TEXT NOT NULL,             -- converging | waiting_review | escalated | converged | abandoned
  current_round    INTEGER NOT NULL DEFAULT 0,
  process_key      TEXT,                       -- engine process-instance key
  waiting_since    TEXT,                       -- ISO ts we began waiting for a review (poller cursor)
  last_review_id   INTEGER,                    -- last GitHub review id we reacted to
  outcome          TEXT,                       -- final summary
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  converged_at     TEXT
);

CREATE TABLE rounds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key      TEXT NOT NULL REFERENCES pull_requests(pr_key),
  round_no    INTEGER NOT NULL,
  status      TEXT,                             -- converged | addressed | needs_input | blocked
  summary     TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);

CREATE TABLE escalations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key      TEXT NOT NULL REFERENCES pull_requests(pr_key),
  round_no    INTEGER NOT NULL,
  kind        TEXT NOT NULL,                    -- question | blocker
  question    TEXT NOT NULL,
  answer      TEXT,
  status      TEXT NOT NULL,                    -- open | answered
  asked_at    TEXT NOT NULL,
  answered_at TEXT
);

CREATE INDEX idx_pr_status ON pull_requests(status);
CREATE INDEX idx_rounds_pr ON rounds(pr_key);
CREATE INDEX idx_esc_pr ON escalations(pr_key);
```

## 8. Web UI + API routes (`main.ts` / `public/`) — PROPOSED

Custom UI (there is no built-in surface for a PR list). Served from `public/`.

- **Active view** — PRs where `status != converged/abandoned`, each a collapsible
  card: repo/#number/title, current status + round, per-round summaries, and any
  **open escalation** with an inline answer box.
- **History view** — converged/abandoned PRs with their full round history.
- **Submit** — a form (`repo`, `number` or a pasted URL).

API:
| method | route | purpose |
|---|---|---|
| `GET` | `/api/prs?scope=active\|history` | list PRs + nested rounds/escalations |
| `POST` | `/api/prs` | submit a PR (form) → start the process |
| `POST` | `/hooks/submit` | webhook submit (HMAC/shared-secret auth) → start the process |
| `POST` | `/api/prs/:prKey/answer` | answer an open escalation → publish `escalation-answered` |
| `GET` | `/` + static | the SPA |

## 9. Prompt asset mechanism (agreed: option A)

`prompts/review-round.md` is the single source of truth for the agent's
instructions. The **Register & load prompt** task reads it at instance start and
sets `prompt` once; every round's agent job receives it via input mapping. A PR
therefore keeps the prompt it started with for its whole run. (Future option:
version the prompt with a hash so edits are auditable per PR.)

## 10. Poller

An in-app loop (interval `NANO_PR_POLL_MS`, default 60s):
1. `SELECT pr_key, repo, number, waiting_since, last_review_id FROM pull_requests WHERE status = 'waiting_review'`.
2. For each, GET the PR's reviews from GitHub; find the newest review submitted
   after `waiting_since` with id > `last_review_id`.
3. If found → publish `review-ready` (key = `pr_key`, `{reviewId, ...}`) and set
   `last_review_id`.

Requires a GitHub token (`GITHUB_TOKEN`). One cheap API call per waiting PR per
interval.

## 11. Configuration (env, `${VAR:-default}` in the manifest)

| var | default | purpose |
|---|---|---|
| `PORT` | 8090 | app HTTP port |
| `NANO_APP_DB_URL` | `file:./app.db` | sqlite |
| `GITHUB_TOKEN` | — | GitHub API (poller + agent) |
| `NANO_PR_POLL_MS` | 60000 | poll interval |
| `NANO_PR_MAX_ROUNDS` | 10 | escalate after N rounds |
| `NANO_PR_WEBHOOK_SECRET` | — | HMAC for `/hooks/submit` |

## 12. Open questions / future

- **Provisioning the existing PR branch** — the harness must checkout the PR's
  head branch and push back to it (not create a new branch/PR). Open: does the app
  resolve the head branch (it already has `GITHUB_TOKEN` in the poller) and pass
  `headBranch` in the job payload, or does the `c8ctl` integration resolve it from
  `prNumber`? Leaning app-supplied (`headBranch`) so the job is self-describing and
  the worker stays a pure provisioner.
- **review-ready via GitHub webhook** — same message, swappable faster trigger,
  when the app is publicly reachable. Deferred (poller-only for v1).
- **Supervised vs external worker** — the agent runs as an external
  `c8ctl nano work` daemon by default; a supervised in-server mode is possible
  later (ADR 0041 decision).
- **Prompt versioning/hash** per PR for auditability.
- **Auth on the web UI** — the manifest `security` block (ADR 0028) if this is
  exposed beyond localhost.
