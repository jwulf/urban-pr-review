# urban-pr-review

A Nano **Urban app** that drives GitHub pull requests to **convergence** against
an automated reviewer (e.g. GitHub Copilot's PR review), one durable, multi-round
loop per PR.

The reviewer-agent is **decoupled**: from this app's point of view it is just a
BPMN service task (`senior:pr-review`) with a job payload. Whether a Copilot
instance (via `c8ctl nano hire`/`work`), a script, or anything else services
that job is the worker's concern — this app never names it.

See [`SPEC.md`](./SPEC.md) for the full design.

## HOWTO: run agents that converge PRs for you, all day

### The problem this solves

Driving a PR to convergence is mostly *waiting*: open a review, wait 5–15 min for
the reviewer, address the comments, re-request, wait again — often ten rounds
deep, escalating to a human only when the reviewer is stuck. If a single agent
babysits one PR, it spends almost all of its time **idle-polling** a review that
hasn't landed yet. That is wasted wall-clock and a wasted worker slot.

This app inverts that. **The BPMN process owns the durable wait** between rounds
(a real message-catch event), so no agent is ever parked holding a job slot while
a review is pending. Instead you **hire a couple of agent workers once**, and they
pull `senior:pr-review` jobs from *whatever PR is ready right now* — alternating
across all in-flight reviews. Two agents can keep a dozen PRs converging in
parallel, and they only run when there is actual work to do.

Set that up by: **(1)** running this app, **(2)** submitting PRs, and **(3)**
hiring agent workers with [`c8ctl nano`](https://github.com/jwulf/c8ctl-plugin-nano).

### 0. Prerequisites

- A running **Nano gateway/engine** (default `http://localhost:8080`). This is
  what the app deploys to and what agents pull jobs from.
- **[Node](https://nodejs.org/)** >= 22.6 (to run this app — it hosts on Node's
  built-ins: `node:sqlite`, `node:http`; `@nanobpm/urban` declares `engines.node
  >=22.6`). **[Deno](https://deno.land/)** is *optional*, used only to
  cross-compile a standalone binary (`npm run compile`). Also install the **c8ctl
  CLI with the `nano` plugin** (to hire/run agents).
- On each machine that will *host an agent*: the **GitHub CLI** logged in
  (`gh auth login`) or a `GITHUB_TOKEN`/`GH_TOKEN` in the environment, and the
  agent harness itself — e.g. the **[Copilot CLI](https://github.com/github/copilot-cli)**
  (`copilot`).

### 1. Install the app into your Nano IDE

Open the Nano console and **Projects → Import by reference**, pointing at this
app's folder (ADR 0041). That registers the app so the console can start it, or
drop a `*.project-ref.json` next to your other projects. `nano-ide.ext.json`
marks it as an example so it shows up in the examples list.

You can also just run it standalone (next step) — the IDE import is only needed if
you want to launch/manage it from the console.

### 2. Start the app

```sh
npm start              # → http://localhost:8090
```

That deploys `convergence-loop.bpmn`, starts the app-hosted record workers, serves
the web UI at **<http://localhost:8090>**, and runs the review-ready poller. See
[Run](#run) and [Configuration](#configuration) for the authoritative port and
env-var details (`NANO_PR_GITHUB_TRANSPORT`/`GITHUB_TOKEN` for the poller,
`NANOBPMN_BASE_URL` for a non-default gateway, etc.).

### 3. Submit a PR

From the UI (`owner/repo#123` or a PR URL), the API, or the webhook — see
[Run](#run) below. Each submitted PR starts one durable `convergence-loop`
instance that parks on a message-catch event until an agent services its
`senior:pr-review` round.

### 4. Hire an agent worker

An agent is a CLI harness (Copilot CLI here) turned into a Nano job worker. Hire a
profile whose **rank + capability** produce the `senior:pr-review` token this app's
task uses:

```sh
c8ctl nano hire \
  --name reviewer \
  --rank senior \
  --capabilities pr-review \
  --command 'copilot -p - --allow-all-tools' \
  --model <your-model>
```

- `--rank senior` + `--capabilities pr-review` makes the worker subscribe to the
  `senior:pr-review` job type (the rank×capability matrix). That is exactly the
  task type this app emits.
- `--command 'copilot -p - --allow-all-tools'` starts the Copilot CLI reading its
  prompt from **stdin** (`-p -`). The harness pipes the whole job JSON (prompt +
  `job.variables`: `prUrl`, `repo`, `prNumber`, `round`, `answer?`) to stdin;
  `prompts/review-round.md` tells the agent how to read it and where to write its
  result.
- **`--allow-all-tools` is the crucial flag.** Without it, Copilot pauses to ask
  permission before each tool call — and an unattended worker has no human to
  answer, so the job stalls. `--allow-all-tools` lets it run the whole round
  non-interactively. (Pair with `--deny-tool` if you want to blocklist specific
  tools.)

  > ⚠️ **Only enable `--allow-all-tools` for code and hosts you trust.** It grants
  > the agent unattended, broad permissions (shell, file writes, network). Each
  > job runs in a throwaway per-job workspace (see below), but the worker still
  > runs as your user on the host — don't point it at untrusted PRs on a shared
  > machine. Use `--deny-tool` to narrow it, or a container sandbox for stronger
  > isolation.

### 5. Put the agent to work

```sh
c8ctl nano work reviewer      # polls for senior:pr-review jobs until Ctrl-C
```

Now every PR you submit gets picked up automatically. Start a **second** worker
(same command, another terminal or another machine) and the two alternate across
whichever PRs are ready — that is the idle-time you reclaim. Run more than one job
at once per worker with `--max-parallel 2`.

### Isolation — each job gets its own clean workspace

In the default **host mode** (`--sandbox none`), the worker provisions a
**throwaway, per-job workspace**: a fresh clone under `<state>/agent-runs/run-*`
checked out on the PR's head branch, exposed to the agent as `AGENT_WORKSPACE` /
`REPO_URL` / `REPO_BRANCH` / `REPO_REF`, and **reaped after the job**. So multiple
agents on one host don't step on each other, and `prompts/review-round.md` already
instructs the agent to stay inside its working directory.

Host workers inherit *your* `gh`/`GITHUB_TOKEN` login, so no extra auth is needed.
Docker/podman sandboxes exist (`--sandbox docker --image …`) for stronger
isolation, but container-side git provisioning is a later increment — container
jobs don't clone yet, and don't inherit your host login (pass credentials via
`--secret-resolver host` / `secretRefs`). For the review loop, **host mode is the
recommended setup.**

### Run it across spare hardware (incl. a Raspberry Pi)

Nano ships ARM binaries (arm64/armv7/armv6), so the whole thing scales down nicely:

- **All-in-one:** run the gateway, this app, and one or two workers on your laptop.
- **Distributed:** run the **Nano gateway on a Raspberry Pi** (always-on, low
  power), run this app anywhere, and put **agent workers on spare machines** — each
  worker just needs the c8ctl CLI, the Copilot CLI logged in, and
  `NANOBPMN_BASE_URL` pointed at the Pi. Add or remove workers at will; the BPMN
  process holds all durable state, so workers are stateless and disposable.

The payoff: instead of one agent burning wall-clock polling a single PR, a small
pool of always-available workers keeps every open review converging — and idles to
zero cost when there's nothing to do.

## How it works

```
 submit (UI / webhook) ──► createProcessInstance ──► convergence-loop (BPMN)
                                                        │
                          ┌── converged ──► finalize ──► done
   Review round (agent) ──┼── addressed ──► record ──► wait review-ready ─┐
   taskType senior:pr-review└── needs_input/blocked ─► escalate ─► wait ───┤
        ▲                                             escalation-answered │
        └─────────────────────── loop ───────────────────────────────────┘

 poller ── polls GitHub for a new review ──► publishes `review-ready`
 UI answer box ── POST /app/actions/message ──────► publishes `escalation-answered`
```

- **BPMN owns the durable wait** between rounds (message catch events), so agent
  worker slots and job timeouts are never held hostage to review latency.
- **App-hosted workers** (`pr.persist-round`, `pr.persist-escalation`,
  `pr.finalize`) keep the SQLite state in sync with process progress.
- **Poller** watches `waiting_review` PRs and publishes `review-ready` when a new
  review lands — no GitHub webhook needed (works behind NAT).

### Merge stage

With `NANO_PR_AUTO_MERGE` on (the default), a converged PR does not stop — the
`pr.finalize` worker starts a second durable process, `merge-loop`, which merges
it for you:

```
 converged ──► finalize ──► createProcessInstance ──► merge-loop (BPMN)
                                                        │
   wait: deps merged ──► arm ──► wait: mergeable ──┬─ ready ─► merge ──┬─ merged ─► mark merged ─► done
   (Depends-on PRs)                                │                   ├─ queued ─► wait: landed ─► mark merged
                                                   └─ conflict/blocked │
                                                        ▼              └─ blocked ─► escalate ─► wait: answered ┐
                                                     escalate ─► wait: answered ───────────────────────────────┘
                                                                          (re-arm and retry)
```

- **Dependencies** — a PR can declare `Depends-on: owner/repo#N` (in the PR body
  or the `dependsOn` submit field); `merge-loop` parks at *wait: deps merged*
  until every dependency has landed. The poller advances it (`deps-cleared`).
- **Strategy is auto-detected** — `pr.merge` attempts the merge; if the branch
  requires a **merge queue**, GitHub enqueues it and the process waits for
  `merge-landed`; otherwise it's a straight squash/merge/rebase.
- **Blocks escalate** — a conflict or a failing required gate raises the same
  escalation machinery as the review stage; answer it in the UI and the process
  re-arms and retries. Set `NANO_PR_AUTO_MERGE=0` to stop at `converged`
  (review-only mode).

## Fleet mode: hand it an issue (plan → implement → converge)

Beyond reviewing a single PR, the app can take a whole **issue** and drive a fleet
of agents to implement it (SPEC §12, issue #14):

```
 issue (UI / POST /hooks/plan) ─► plan-fanout (BPMN)
    plan (senior:plan) ─► record-plan ─► implement × N (parallel, senior:feature) ─► record-results
                                                                                        │
                                          each opened PR ──► submitPr ──► convergence-loop (above)
```

1. A **planning agent** (`senior:plan`) reads the issue and emits a list of tasks.
2. A **parallel multi-instance** activity fans the tasks out over
   **implementation agents** (`senior:feature`), one PR per task.
3. `record-results` **enrols every opened PR** into the convergence loop — so the
   fleet's PRs are reviewed to convergence just like a hand-submitted one.

Submit an issue from the **"Hand an issue to the fleet"** form on the home page, or:

```bash
curl -sS -X POST http://localhost:3000/hooks/plan \
  -H 'content-type: application/json' \
  -H "x-hook-secret: $NANO_PR_WEBHOOK_SECRET" \
  -d '{ "issue": "owner/repo#123" }'
```

Watch progress in the **Plans** grid (expand a plan to see its tasks and the PRs
they produced). The agents driving `senior:plan`/`senior:feature` are the same
external `c8ctl nano work` workers, matched by rank×capability.

## Layout

| path | purpose |
|---|---|
| `nano.app.json` | manifest (ADR 0027): sqlite datasource + app-hosted workers |
| `main.ts` | entrypoint: deploy, start workers, serve the page runtime + action overrides, run poller |
| `lib/nano.ts` | deploy/worker bootstrap helpers (`@lib/nano.ts`) |
| `resources/processes/convergence-loop.bpmn` | the durable convergence process |
| `resources/processes/merge-loop.bpmn` | the durable merge process (deps → merge → escalate) |
| `db/migrations/001_init.sql` | `pull_requests` / `rounds` / `escalations` |
| `db/migrations/004_merge.sql` | `merged_at` column + `pr_dependencies` / `merges` |
| `workers/*/worker.ts` | app-hosted record workers |
| `prompts/review-round.md` | the agent's instructions (carried in the job payload) |
| `components/review-round.json` | Zeebe element template for the agent task |
| `pages/home.page.json` | the screen, authored declaratively (ADR 0042 Page Composer) |

## Clients

`main.ts` uses three surfaces (all aliased in `deno.json`):

- **`@nanobpm/nano-sdk`** — the **engine** client (`createProcessInstance`,
  `publishMessage`).
- **`@nanobpm/domain`** — the app's **own** sqlite datasource as a typed domain
  object: `const db = await openDomain("app")` gives typed table accessors
  (`db.pull_requests`, `db.rounds`, `db.escalations`) with `insert`/`get`/`find`/
  `update`/`delete`, plus `db.raw` as the escape hatch for set/ordered SQL.

- **`@nanobpm/app`** — the generic **page runtime**: it renders
  `pages/home.page.json` into a served, data-bound screen (list, filter, detail,
  row actions) with no hand-written frontend. `main.ts` intercepts only the three
  app-specific actions (start a review, cancel a run, answer an escalation) and
  delegates everything else to it.

Workers use **`@nanobpm/worker`** (`defineWorker`) and open the same typed domain
with `openDomain("app")`.

## Configuration

| env | default | purpose |
|---|---|---|
| `PORT` | `8090` | app HTTP port |
| `NANO_APP_DB_URL` | `file:./app.db` | sqlite datasource |
| `NANOBPMN_BASE_URL` | `http://localhost:8080` | engine base URL |
| `NANO_PR_GITHUB_TRANSPORT` | `auto` | how the poller reads GitHub reviews: `gh` (host `gh` CLI — reaches every repo you can, no PAT needed), `token` (`GITHUB_TOKEN` over HTTP), or `auto` (prefer `gh`, else token) |
| `GITHUB_TOKEN` | — | token for the `token`/`auto` transport (idle if no transport is usable) |
| `NANO_PR_POLL_MS` | `60000` | review-ready poll interval |
| `NANO_PR_MAX_ROUNDS` | `20` | default cap: escalate after N rounds (per-submit override via the form / webhook `maxRounds`; clamped to 1–100) |
| `NANO_PR_WEBHOOK_SECRET` | — | shared secret for `POST /hooks/submit` (`X-Hook-Secret`) |
| `NANO_PR_AUTO_MERGE` | `1` | after convergence, run the merge stage; `0` = stop at `converged` (review-only) |
| `NANO_PR_MERGE_METHOD` | `squash` | merge method: `squash`, `merge`, or `rebase` |
| `NANO_PR_MERGE_ADMIN` | `0` | pass `--admin` to override failing non-required checks (use with care) |

## Run

Against a running Nano engine:

```sh
npm start
```

Then open <http://localhost:8090>. Or import it by reference into a Nano server
(ADR 0041) and run it there.

Submit a PR from the UI (`owner/repo#123` or a PR URL), via the API, or the
webhook:

```sh
curl -XPOST localhost:8090/app/actions/start/convergence-loop \
  -H 'content-type: application/json' \
  -d '{"variables":{"pr":"https://github.com/owner/repo/pull/123"}}'

curl -XPOST localhost:8090/hooks/submit -H 'x-hook-secret: $SECRET' \
  -H 'content-type: application/json' -d '{"url":"owner/repo#123"}'
```

To make a PR wait for another to merge first, either add a `Depends-on:
owner/repo#N` line to its PR body, or declare it on submit (`dependsOn` accepts
`owner/repo#N` refs or PR URLs):

```sh
curl -XPOST localhost:8090/hooks/submit -H 'content-type: application/json' \
  -d '{"url":"owner/repo#124","dependsOn":["owner/repo#123"]}'
```

## Purge

The app keeps its own SQLite state (PRs/rounds/escalations) separate from the
engine. When you purge and restart the engine, wipe the app db too so the two
stay consistent:

```sh
npm run purge   # deletes app.db (+ WAL/SHM) and re-applies db/migrations
```

## Compile to a native binary (no runtime install required)

The app is authored on Node's built-ins (`node:sqlite`, `node:http`, `process.env`),
so **Deno** can cross-compile it into a native executable that bundles the Deno
runtime (its `denort` binary, which supplies the `node:*` compatibility APIs), the
npm dependencies and the app's entry code — so the target box needs **no
Node/Deno/`node_modules` install**:

```sh
npm run compile   # → dist/urban-pr-review  (via `deno compile`)
```

> **Not (yet) a single self-contained file.** The binary bundles the runtime + deps
> + entry code, but the Urban runtime loads the app's declarative files —
> `nano.app.json`, `pages/`, `db/migrations/`, `prompts/`, `resources/` and the
> `actions/`/`workers/` modules — from the **working directory at runtime** (via
> `readTextFile` + dynamic `import`). `deno compile` *can* embed data dirs into its
> virtual filesystem with
> [`--include`](https://docs.deno.com/runtime/reference/cli/compile/#including-data-files-or-directories),
> but embedded files are only reachable relative to `import.meta.dirname`, whereas
> the runtime resolves them against `Deno.cwd()` — so today you must ship the binary
> **alongside those app files** and run it from that directory (it then boots
> identically to `npm start`, same env vars). Making a truly self-contained binary
> needs an *embeddable Urban app* capability in `@nanobpm/urban` (resolve the app
> root from `import.meta.dirname` + `--include` the non-statically-analyzable
> `actions/`/`workers/` dynamic imports), tracked separately. Add `--target` in the
> `deno.json` `compile` task to cross-compile for another OS/arch.

## The agent (external worker)

The `senior:pr-review` task is serviced by an external worker — it is **not** in
the manifest `workers[]`. Point a `c8ctl nano work` daemon (or any Zeebe-style
worker) at task type `senior:pr-review`; each job carries `{prUrl, repo, prNumber,
round, answer?, prompt}` and expects `{status, summary, question?}` back. The
`prompt` is the full text of `prompts/review-round.md`.
