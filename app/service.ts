// urban-pr-review — the app's business logic over the Urban runtime seams (ADR 0055).
//
// The action handlers (`actions/*.ts`) and the review-ready poller (`main.ts`) both call
// these functions. Actions receive `app.data` (the typed datasource gateway) and
// `app.engine` (the transport-agnostic engine client) from the injected `AppApi`; the
// poller passes the same `DataLayer` + `EngineClient` obtained from `main.ts`.
//
// Data access goes through the record-oriented gateway (`data.table<T>(name, pk)` — the RAD
// `Table<T>` surface), not hand-written SQL. Row shapes are declared inline here.
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import {
  classifyMergeability,
  fetchPrMeta,
  fetchPrReviews,
  fetchPrState,
  type MergeMethod,
} from "./github.ts";

/** The BPMN process that drives review convergence (`resources/processes/convergence-loop.bpmn`). */
export const PROCESS_ID = "convergence-loop";
/** The BPMN process that lands a converged PR (`resources/processes/merge-loop.bpmn`). */
export const MERGE_PROCESS_ID = "merge-loop";
/** Job type of the external review agent (the `review-round` service task's `zeebe:taskDefinition`
 * in convergence-loop.bpmn). Deliberately NOT hosted here — an external harness services it; the
 * activation poll keys off it to tell "agent working" from "queued". */
const REVIEW_JOB_TYPE = "senior:pr-review";
/** Round cap before the loop escalates to a human. */
export const MAX_ROUNDS = Number(process.env.NANO_PR_MAX_ROUNDS ?? 10);

/** Whether a converged PR is automatically driven to merge (the merge-loop). Default on; set
 * `NANO_PR_AUTO_MERGE=0` to stop at `converged` (review-only mode). */
export const AUTO_MERGE = !["0", "false", "off", "no"].includes(
  (process.env.NANO_PR_AUTO_MERGE ?? "1").trim().toLowerCase(),
);
/** Merge method passed to `gh pr merge` / the REST merge API. */
export const MERGE_METHOD: MergeMethod = (() => {
  const m = (process.env.NANO_PR_MERGE_METHOD ?? "squash").trim().toLowerCase();
  return m === "merge" || m === "rebase" ? m : "squash";
})();
/** Whether to pass `--admin` to `gh pr merge` (bypass branch policy where the operator is an
 * admin — mirrors the manual `gh pr merge --squash --admin` fallback some repos require). */
export const MERGE_ADMIN = ["1", "true", "on", "yes"].includes(
  (process.env.NANO_PR_MERGE_ADMIN ?? "0").trim().toLowerCase(),
);

// The prompt asset is read once at module load and carried on each new instance (SPEC §9),
// so a PR keeps the instructions it started with for its whole run. Host-agnostic: reads via
// Deno inside a compiled binary, else via node:fs under Node.
const REVIEW_PROMPT = await (async () => {
  const path = "prompts/review-round.md";
  try {
    const g = globalThis as { Deno?: { readTextFile(p: string): Promise<string> } };
    return g.Deno?.readTextFile
      ? await g.Deno.readTextFile(path)
      : await (await import("node:fs/promises")).readFile(path, "utf8");
  } catch {
    return "";
  }
})();

const now = () => new Date().toISOString();

/** A PR is "done" in exactly these states; everything else (converging, waiting_review,
 * escalated, and the merge-stage waiting_deps/waiting_merge/queued) is in flight. `converged`
 * is terminal only in review-only mode (AUTO_MERGE off); with auto-merge on, a converged PR
 * transitions into the merge stage and lands as `merged`. The status endpoint and the cancel
 * guard both key off this set. */
export const TERMINAL_STATUSES: readonly string[] = ["converged", "merged", "abandoned"];

interface PullRequest {
  pr_key: string;
  repo: string;
  number: number;
  url: string;
  title: string | null;
  status: string;
  current_round: number;
  process_key: string | null;
  waiting_since: string | null;
  last_review_id: number | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
  converged_at: string | null;
  merged_at: string | null;
  open_escalation_id: number | null;
  open_escalation_question: string | null;
  // Job-activation visibility (005_job_activation.sql), written by the poller's
  // `pollJobActivation` pass. `active_worker` is the leasing worker's name while an
  // agent is actively working the `senior:pr-review` round; NULL means the job is
  // queued (created, not yet activated) or the process isn't at review-round.
  active_worker: string | null;
  lease_until: string | null;
}

interface PrDependency {
  pr_key: string;
  depends_on_key: string;
  created_at: string;
}

interface Escalation {
  id: number;
  pr_key: string;
  round_no: number;
  kind: string;
  question: string;
  answer: string | null;
  status: string;
  asked_at: string;
  answered_at: string | null;
}

const prs = (data: DataLayer) => data.table<PullRequest>("pull_requests", "pr_key");
const escs = (data: DataLayer) => data.table<Escalation>("escalations", "id");
const deps = (data: DataLayer) => data.table<PrDependency>("pr_dependencies", "pr_key");

export interface ParsedPr {
  repo: string;
  number: number;
  url: string;
  prKey: string;
}

/** Parse "owner/repo#123" or a canonical PR URL into its parts. */
export function parsePr(input: string): ParsedPr | null {
  const s = input.trim();
  let m = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    const number = Number(m[3]);
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, prKey: `${repo}#${number}` };
  }
  m = s.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (m) {
    const repo = m[1];
    const number = Number(m[2]);
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, prKey: `${repo}#${number}` };
  }
  return null;
}

/** Extract `Depends-on: owner/repo#N[, owner/repo#N …]` (or PR URLs) from a PR body. Multiple
 * `Depends-on:` lines accumulate; each line may list several comma/space-separated refs. Returns
 * the normalized `owner/repo#N` keys. Unparseable tokens are ignored. */
export function parseDependsOn(body: string): string[] {
  const out = new Set<string>();
  for (const line of (body ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*depends[-\s]?on\s*:\s*(.+)$/i);
    if (!m) continue;
    for (const tok of m[1].split(/[,\s]+/)) {
      const p = parsePr(tok);
      if (p) out.add(p.prKey);
    }
  }
  return [...out];
}

/** Replace a PR's dependency set (idempotent on resubmit). Self-references are dropped so a PR
 * can never wait on itself. */
async function registerDependencies(data: DataLayer, prKey: string, depKeys: string[]) {
  const table = deps(data);
  // The gateway keys this table on `pr_key`, so a single delete clears the PR's whole dep set
  // (DELETE ... WHERE pr_key = ?) — then we re-insert the current set.
  await table.delete(prKey);
  const ts = now();
  for (const depKey of new Set(depKeys)) {
    if (depKey === prKey) continue;
    await table.insert({ pr_key: prKey, depends_on_key: depKey, created_at: ts });
  }
}

/** Register a PR row (if new) and start the convergence process. Idempotent on prKey. Optional
 * `dependsOn` (explicit refs) is unioned with any `Depends-on:` line parsed from the PR body and
 * recorded as the PR's merge-stage dependency set. */
export async function submitPr(
  data: DataLayer,
  engine: EngineClient,
  parsed: ParsedPr,
  dependsOn: string[] = [],
) {
  const table = prs(data);
  const existing = await table.get(parsed.prKey);
  if (existing && !TERMINAL_STATUSES.includes(existing.status)) {
    return { prKey: parsed.prKey, alreadyRunning: true };
  }

  // Best-effort GitHub read: the title labels the row and the body may carry `Depends-on:` refs.
  // A transport failure (no gh/token) must not block submission — we just skip enrichment.
  const token = process.env.GITHUB_TOKEN ?? "";
  let title: string | null = null;
  const depKeys = new Set(dependsOn.map((d) => parsePr(d)?.prKey).filter((k): k is string => !!k));
  try {
    const meta = await fetchPrMeta(parsed.repo, parsed.number, token);
    if (meta) {
      title = meta.title;
      for (const k of parseDependsOn(meta.body)) depKeys.add(k);
    }
  } catch (err) {
    console.warn(`[submit] ${parsed.prKey} meta fetch: ${err}`);
  }
  await registerDependencies(data, parsed.prKey, [...depKeys]);

  const ts = now();
  if (existing) {
    // Re-open a previously converged/abandoned/merged PR for a fresh convergence run.
    await table.update(parsed.prKey, {
      status: "converging",
      current_round: 1,
      url: parsed.url,
      title: title ?? existing.title,
      waiting_since: null,
      last_review_id: null,
      outcome: null,
      converged_at: null,
      merged_at: null,
      updated_at: ts,
    });
  } else {
    await table.insert({
      pr_key: parsed.prKey,
      repo: parsed.repo,
      number: parsed.number,
      url: parsed.url,
      title,
      status: "converging",
      current_round: 1,
      created_at: ts,
      updated_at: ts,
    });
  }
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId: PROCESS_ID,
    variables: {
      repo: parsed.repo,
      prNumber: parsed.number,
      prUrl: parsed.url,
      prKey: parsed.prKey,
      round: 1,
      maxRounds: MAX_ROUNDS,
      prompt: REVIEW_PROMPT,
    },
  });
  if (processInstanceKey != null) {
    await table.update(parsed.prKey, { process_key: String(processInstanceKey) });
  }
  return { prKey: parsed.prKey, processKey: processInstanceKey };
}

/** Start the merge-loop for a converged PR (called by the `pr.finalize` worker when AUTO_MERGE
 * is on). Carries the same PR identity + the converged round so the merge stage can escalate
 * with a round number. Idempotent-ish: the caller only invokes this once per convergence. */
export async function startMerge(
  data: DataLayer,
  engine: EngineClient,
  pr: { repo: string; number: number; url: string; prKey: string; round: number },
) {
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId: MERGE_PROCESS_ID,
    variables: {
      repo: pr.repo,
      prNumber: pr.number,
      prUrl: pr.url,
      prKey: pr.prKey,
      round: pr.round,
    },
  });
  if (processInstanceKey != null) {
    await prs(data).update(pr.prKey, { process_key: String(processInstanceKey), updated_at: now() });
  }
  return { prKey: pr.prKey, mergeProcessKey: processInstanceKey };
}

/** Answer an open escalation → record it and resume the process. */
export async function answerEscalation(
  data: DataLayer,
  engine: EngineClient,
  prKey: string,
  answer: string,
) {
  const open = (await escs(data).find({ pr_key: prKey, status: "open" })).sort((a, b) => b.id - a.id)[0];
  if (!open) return { ok: false, reason: "no open escalation" };
  const ts = now();
  await escs(data).update(open.id, { answer, status: "answered", answered_at: ts });
  await prs(data).update(prKey, {
    status: "converging",
    updated_at: ts,
    open_escalation_id: null,
    open_escalation_question: null,
  });
  await engine.publishMessage({
    name: "escalation-answered",
    correlationKey: prKey,
    variables: { answer, escalationId: open.id },
  });
  return { ok: true, escalationId: open.id };
}

/** How a caller identifies the run to cancel: by its engine `processInstanceKey` or, more
 * ergonomically, by the `prKey` the status endpoint reports. The cancel action rejects a
 * request that supplies both, so exactly one selector reaches here. */
export interface CancelSelector {
  processInstanceKey?: string;
  prKey?: string;
}

/** Cancel a PR's running convergence instance and mark it abandoned. Terminating the engine
 * instance emits no completion event (no worker runs), so the app-tier flips the PR's status
 * here — the same place ADR 0040 puts app-owned rest state. Accepts either selector; a PR
 * already in a terminal state is left untouched so a stale cancel can't overwrite a `converged`
 * outcome with `abandoned`. */
export async function cancelRun(data: DataLayer, engine: EngineClient, selector: CancelSelector) {
  const { processInstanceKey, prKey } = selector;
  const table = prs(data);
  const pr = prKey
    ? await table.get(prKey)
    : processInstanceKey
    ? (await table.find({ process_key: processInstanceKey }))[0]
    : undefined;
  if (pr && TERMINAL_STATUSES.includes(pr.status)) {
    return { ok: false, kind: "terminal", reason: `PR already ${pr.status}`, prKey: pr.pr_key };
  }
  const instanceKey = pr?.process_key ?? processInstanceKey ?? null;
  if (instanceKey) {
    try {
      await engine.cancelInstance({ processInstanceKey: instanceKey });
    } catch (err) {
      // The instance may already be gone (converged/cancelled) — still reconcile the app row so
      // a stale "converging" PR can't linger in the UI.
      console.warn(`[cancel] engine cancel for ${instanceKey}: ${err}`);
    }
  }
  if (pr) {
    await table.update(pr.pr_key, {
      status: "abandoned",
      updated_at: now(),
      open_escalation_id: null,
      open_escalation_question: null,
    });
    return { ok: true, prKey: pr.pr_key };
  }
  return { ok: false, kind: "not_found", reason: "no PR for that selector" };
}

/** A PR currently in flight, as reported by the status endpoint. */
export interface ActivePr {
  prKey: string;
  repo: string;
  number: number;
  url: string;
  title: string | null;
  status: string;
  round: number;
  processKey: string | null;
  waitingSince: string | null;
  openEscalation: string | null;
  updatedAt: string;
  /** Leasing worker while an agent is actively working the review round; null when queued
   * (job created, not yet activated) or not at the review-round task. */
  activeWorker: string | null;
  /** ISO ts the current activation lease expires; null when not activated. */
  leaseUntil: string | null;
}

/** Every tracked PR not in a terminal state (converged/abandoned), newest-updated first. Backs
 * the GET status endpoint so an operator or an external harness can see what is in flight
 * without reading the datasource directly. */
export async function activePrs(data: DataLayer): Promise<ActivePr[]> {
  const all = await prs(data).all();
  return all
    .filter((p) => !TERMINAL_STATUSES.includes(p.status))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .map((p) => ({
      prKey: p.pr_key,
      repo: p.repo,
      number: p.number,
      url: p.url,
      title: p.title ?? null,
      status: p.status,
      round: p.current_round,
      processKey: p.process_key ?? null,
      waitingSince: p.waiting_since ?? null,
      openEscalation: p.open_escalation_question ?? null,
      updatedAt: p.updated_at,
      activeWorker: p.active_worker ?? null,
      leaseUntil: p.lease_until ?? null,
    }));
}

/** One review-ready poll pass (SPEC §10): for every PR waiting on a review, fetch its GitHub
 * reviews (via the host `gh` CLI or a token — see `app/github.ts`) and, on a fresh one,
 * correlate a `review-ready` message to resume the loop. */
async function pollReviews(data: DataLayer, engine: EngineClient, token: string) {
  const waiting = await prs(data).find({ status: "waiting_review" });
  for (const pr of waiting) {
    const { repo, number, pr_key: prKey } = pr;
    const lastId = pr.last_review_id ?? 0;
    try {
      const reviews = await fetchPrReviews(repo, number, token);
      if (reviews === null) return; // no usable transport (no gh, no token) → idle
      const fresh = reviews
        .filter((rv) =>
          rv.id > lastId && rv.submitted_at && (!pr.waiting_since || rv.submitted_at >= pr.waiting_since)
        )
        .sort((a, b) => a.id - b.id)
        .pop();
      if (!fresh) continue;
      await prs(data).update(prKey, { last_review_id: fresh.id, status: "converging", updated_at: now() });
      await engine.publishMessage({
        name: "review-ready",
        correlationKey: prKey,
        variables: { reviewId: fresh.id, reviewState: fresh.state, submittedAt: fresh.submitted_at },
      });
      console.log(`[poller] review ${fresh.id} (${fresh.state}) -> ${prKey}`);
    } catch (err) {
      console.error(`[poller] ${prKey}: ${err}`);
    }
  }
}

/** Is a dependency PR merged? Prefer our own tracked row (cheap, authoritative once we've
 * merged it); otherwise ask GitHub whether that PR has merged (it may be an untracked PR, or
 * one merged out-of-band). A transport failure surfaces as "not merged yet" (caller retries). */
async function isDepMerged(data: DataLayer, depKey: string, token: string): Promise<boolean> {
  const tracked = await prs(data).get(depKey);
  if (tracked && tracked.status === "merged") return true;
  const parsed = parsePr(depKey);
  if (!parsed) return true; // unparseable dep can't be checked on GitHub → treat as cleared so it never wedges the PR
  const st = await fetchPrState(parsed.repo, parsed.number, token);
  return st?.merged ?? false;
}

/** Flip a PR into the transient `merging` status and publish the correlating message, reverting
 * to `prevStatus` if the publish fails. `merging` is deliberately a status no poll branch scans
 * (so a slow pass can't double-signal), which means a publish failure *after* the flip would
 * otherwise wedge the PR there forever — the next pass would never pick it back up. Reverting on
 * failure keeps the PR on a pollable status so the next pass retries. Single source of truth for
 * the flip-then-publish handoff shared by all merge-stage waits below. */
async function flipToMergingThenPublish(
  data: DataLayer,
  engine: EngineClient,
  prKey: string,
  prevStatus: string,
  message: Parameters<EngineClient["publishMessage"]>[0],
) {
  await prs(data).update(prKey, { status: "merging", updated_at: now() });
  try {
    await engine.publishMessage(message);
  } catch (err) {
    try {
      await prs(data).update(prKey, { status: prevStatus, updated_at: now() });
    } catch (revertErr) {
      console.error(`[poller] revert ${prKey} -> ${prevStatus} failed: ${revertErr}`);
    }
    throw err;
  }
}

/** Merge-stage poll pass (SPEC §11). Three durable waits, each keyed off the PR's `status`, are
 * advanced by correlating a message — mirroring the review-ready pattern so the process owns
 * the wait and this glue only signals when a GitHub condition is met:
 *   • waiting_deps  → every declared dependency has merged        → `deps-cleared`
 *   • waiting_merge → GitHub settled the PR as mergeable/blocked  → `merge-ready` {mergeState}
 *   • queued        → the queued PR has landed on GitHub          → `merge-landed`
 * On publish we flip status to the transient `merging` (which no branch scans) so a slow pass
 * can't double-signal, exactly as `pollReviews` flips to `converging`; `flipToMergingThenPublish`
 * reverts the flip if the publish fails so a failed handoff can't wedge the PR. */
async function pollMerges(data: DataLayer, engine: EngineClient, token: string) {
  // 1) Dependencies merged?
  for (const pr of await prs(data).find({ status: "waiting_deps" })) {
    const prKey = pr.pr_key;
    try {
      const depRows = await deps(data).find({ pr_key: prKey });
      let allMerged = true;
      for (const d of depRows) {
        if (!(await isDepMerged(data, d.depends_on_key, token))) {
          allMerged = false;
          break;
        }
      }
      if (!allMerged) continue;
      await flipToMergingThenPublish(data, engine, prKey, "waiting_deps", {
        name: "deps-cleared",
        correlationKey: prKey,
        variables: {},
      });
      console.log(`[poller] deps cleared -> ${prKey}`);
    } catch (err) {
      console.error(`[poller] deps ${prKey}: ${err}`);
    }
  }

  // 2) Mergeable / blocked?
  for (const pr of await prs(data).find({ status: "waiting_merge" })) {
    const { repo, number, pr_key: prKey } = pr;
    try {
      const st = await fetchPrState(repo, number, token);
      if (st === null) continue; // no transport → skip this PR (others may still advance)
      if (st.merged) {
        // Landed out-of-band (someone merged it) — skip straight to done.
        await flipToMergingThenPublish(data, engine, prKey, "waiting_merge", {
          name: "merge-landed",
          correlationKey: prKey,
          variables: {},
        });
        console.log(`[poller] already merged -> ${prKey}`);
        continue;
      }
      const verdict = classifyMergeability(st);
      if (verdict === "waiting") continue; // GitHub still computing / checks pending
      await flipToMergingThenPublish(data, engine, prKey, "waiting_merge", {
        name: "merge-ready",
        correlationKey: prKey,
        variables: { mergeState: verdict },
      });
      console.log(`[poller] mergeable=${verdict} (${st.mergeStateStatus}) -> ${prKey}`);
    } catch (err) {
      console.error(`[poller] merge ${prKey}: ${err}`);
    }
  }

  // 3) Queued PR landed?
  for (const pr of await prs(data).find({ status: "queued" })) {
    const { repo, number, pr_key: prKey } = pr;
    try {
      const st = await fetchPrState(repo, number, token);
      if (st === null) continue; // no transport → skip this PR (others may still advance)
      if (!st.merged) continue; // still in the queue
      await flipToMergingThenPublish(data, engine, prKey, "queued", {
        name: "merge-landed",
        correlationKey: prKey,
        variables: {},
      });
      console.log(`[poller] queued PR landed -> ${prKey}`);
    } catch (err) {
      console.error(`[poller] queued ${prKey}: ${err}`);
    }
  }
}

/** The subset of a Camunda-8 `/v2/jobs/search` result item this app reads. `worker` is the
 * leasing worker's name (empty/absent until an agent activates the job); `deadline` is the
 * activation lock's expiry (ISO ts). */
interface JobSearchItem {
  worker?: string;
  deadline?: string | null;
  state?: string;
}

/** One job-activation poll pass. The `converging` status means the process is parked at the
 * `review-round` service task with a `senior:pr-review` job outstanding — but it does not say
 * whether an external agent has *activated* (leased) that job yet. This pass reads that off the
 * engine's Camunda-8 `/v2/jobs/search`: an activated job carries a leasing `worker` + a lock
 * `deadline`; a merely-created (queued) one carries neither. (The wire `state` can't tell them
 * apart — Camunda's JobStateEnum has no ACTIVATED value, so the engine projects Activated ->
 * CREATED; the `worker`/`deadline` fields are the compatible activation signal.)
 *
 * It writes `active_worker` + `lease_until` onto the PR row so the pages surface can show
 * "agent working" vs "queued (awaiting an agent)", updating (and bumping `updated_at`) only on
 * an actual change so a steady state doesn't churn the grid. Best-effort: any transport failure
 * leaves the last-known values untouched and the next pass retries. */
async function pollJobActivation(
  data: DataLayer,
  restAddress: string,
  engineToken: string | undefined,
) {
  const base = restAddress.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (engineToken) headers.authorization = `Bearer ${engineToken}`;

  const all = await prs(data).all();
  for (const pr of all) {
    // Only a `converging` PR has a live review-round job. Any other status with a stale worker
    // set (e.g. it just moved to `waiting_review`) gets cleared so the grid can't show a
    // phantom "agent working".
    if (pr.status !== "converging") {
      if (pr.active_worker || pr.lease_until) {
        await prs(data).update(pr.pr_key, {
          active_worker: null,
          lease_until: null,
          updated_at: now(),
        });
      }
      continue;
    }
    if (!pr.process_key) continue;

    let worker: string | null = null;
    let leaseUntil: string | null = null;
    try {
      const res = await fetch(`${base}/jobs/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          filter: { type: REVIEW_JOB_TYPE, processInstanceKey: pr.process_key, state: "CREATED" },
          page: { limit: 20 },
        }),
      });
      if (!res.ok) continue; // engine unhappy → keep last-known, retry next pass
      const body = (await res.json()) as { items?: JobSearchItem[] };
      // An open job with a leasing worker means an agent has activated it. Prefer the one with
      // the latest deadline if several are open (there is normally at most one).
      const activated = (body.items ?? [])
        .filter((j) => typeof j.worker === "string" && j.worker.length > 0)
        .sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? ""))
        .pop();
      if (activated) {
        worker = activated.worker ?? null;
        leaseUntil = activated.deadline ?? null;
      }
    } catch (err) {
      console.error(`[poller] job-activation ${pr.pr_key}: ${err}`);
      continue;
    }

    if (worker !== (pr.active_worker ?? null) || leaseUntil !== (pr.lease_until ?? null)) {
      await prs(data).update(pr.pr_key, {
        active_worker: worker,
        lease_until: leaseUntil,
        updated_at: now(),
      });
    }
  }
}

/** One full poll pass: advance the review stage, the merge stage, and (when the engine REST
 * endpoint is supplied) the job-activation visibility pass. Called on the self-scheduling loop
 * in `main.ts`. */
export async function pollOnce(
  data: DataLayer,
  engine: EngineClient,
  token: string,
  engineRest?: { restAddress: string; token?: string },
) {
  await pollReviews(data, engine, token);
  await pollMerges(data, engine, token);
  if (engineRest) await pollJobActivation(data, engineRest.restAddress, engineRest.token);
}

