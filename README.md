# urban-pr-review

A Nano **Urban app** that drives GitHub pull requests to **convergence** against
an automated reviewer (e.g. GitHub Copilot's PR review), one durable, multi-round
loop per PR.

The reviewer-agent is **decoupled**: from this app's point of view it is just a
BPMN service task (`pr-review.round`) with a job payload. Whether a Copilot
instance (via `c8ctl nano recruit`/`work`), a script, or anything else services
that job is the worker's concern — this app never names it.

See [`SPEC.md`](./SPEC.md) for the full design.

## How it works

```
 submit (UI / webhook) ──► createProcessInstance ──► convergence-loop (BPMN)
                                                        │
                          ┌── converged ──► finalize ──► done
   Review round (agent) ──┼── addressed ──► record ──► wait review-ready ─┐
   taskType pr-review.round└── needs_input/blocked ─► escalate ─► wait ───┤
        ▲                                             escalation-answered │
        └─────────────────────── loop ───────────────────────────────────┘

 poller ── polls GitHub for a new review ──► publishes `review-ready`
 UI answer box ── POST /api/prs/:prKey/answer ──► publishes `escalation-answered`
```

- **BPMN owns the durable wait** between rounds (message catch events), so agent
  worker slots and job timeouts are never held hostage to review latency.
- **App-hosted workers** (`pr.persist-round`, `pr.persist-escalation`,
  `pr.finalize`) keep the SQLite state in sync with process progress.
- **Poller** watches `waiting_review` PRs and publishes `review-ready` when a new
  review lands — no GitHub webhook needed (works behind NAT).

## Layout

| path | purpose |
|---|---|
| `nano.app.json` | manifest (ADR 0027): sqlite datasource + app-hosted workers |
| `main.ts` | entrypoint: deploy, start workers, serve UI/API, run poller |
| `lib/nano.ts` | deploy/worker bootstrap helpers (`@lib/nano.ts`) |
| `resources/processes/convergence-loop.bpmn` | the durable convergence process |
| `db/migrations/001_init.sql` | `pull_requests` / `rounds` / `escalations` |
| `workers/*/worker.ts` | app-hosted record workers |
| `prompts/review-round.md` | the agent's instructions (carried in the job payload) |
| `components/review-round.json` | Zeebe element template for the agent task |
| `public/` | the web UI (dependency-free SPA) |

## Clients

`main.ts` uses two surfaces (both aliased in `deno.json`):

- **`@nanobpm/nano-sdk`** — the **engine** client (`createProcessInstance`,
  `publishMessage`).
- **`@nanobpm/data`** — the app's **own** sqlite datasource.

Workers use **`@nanobpm/worker`** (`defineWorker` + `ctx.data("app")`).

## Configuration

| env | default | purpose |
|---|---|---|
| `PORT` | `8090` | app HTTP port |
| `NANO_APP_DB_URL` | `file:./app.db` | sqlite datasource |
| `NANOBPMN_BASE_URL` | `http://localhost:8080` | engine base URL |
| `GITHUB_TOKEN` | — | GitHub API for the poller (idle if unset) |
| `NANO_PR_POLL_MS` | `60000` | review-ready poll interval |
| `NANO_PR_MAX_ROUNDS` | `10` | escalate after N rounds |
| `NANO_PR_WEBHOOK_SECRET` | — | shared secret for `POST /hooks/submit` (`X-Hook-Secret`) |

## Run

Against a running Nano engine:

```sh
deno task start
```

Then open <http://localhost:8090>. Or import it by reference into a Nano server
(ADR 0041) and run it there.

Submit a PR from the UI (`owner/repo#123` or a PR URL), via the API, or the
webhook:

```sh
curl -XPOST localhost:8090/api/prs -H 'content-type: application/json' \
  -d '{"url":"https://github.com/owner/repo/pull/123"}'

curl -XPOST localhost:8090/hooks/submit -H 'x-hook-secret: $SECRET' \
  -H 'content-type: application/json' -d '{"url":"owner/repo#123"}'
```

## The agent (external worker)

The `pr-review.round` task is serviced by an external worker — it is **not** in
the manifest `workers[]`. Point a `c8ctl nano work` daemon (or any Zeebe-style
worker) at task type `pr-review.round`; each job carries `{prUrl, repo, prNumber,
round, answer?, prompt}` and expects `{status, summary, question?}` back. The
`prompt` is the full text of `prompts/review-round.md`.
