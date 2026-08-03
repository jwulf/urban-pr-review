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
import { fetchPrReviews } from "./github.ts";

/** The BPMN process this app drives (see `resources/processes/convergence-loop.bpmn`). */
export const PROCESS_ID = "convergence-loop";
/** Round cap before the loop escalates to a human. */
export const MAX_ROUNDS = Number(process.env.NANO_PR_MAX_ROUNDS ?? 10);

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

/** A PR is "done" in exactly these two states; everything else (converging, waiting_review,
 * escalated) is in flight. The status endpoint and the cancel guard both key off this. */
export const TERMINAL_STATUSES: readonly string[] = ["converged", "abandoned"];

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
  open_escalation_id: number | null;
  open_escalation_question: string | null;
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

/** Register a PR row (if new) and start the convergence process. Idempotent on prKey. */
export async function submitPr(data: DataLayer, engine: EngineClient, parsed: ParsedPr) {
  const table = prs(data);
  const existing = await table.get(parsed.prKey);
  if (existing && !TERMINAL_STATUSES.includes(existing.status)) {
    return { prKey: parsed.prKey, alreadyRunning: true };
  }
  const ts = now();
  if (existing) {
    // Re-open a previously converged/abandoned PR for a fresh convergence run.
    await table.update(parsed.prKey, {
      status: "converging",
      current_round: 1,
      url: parsed.url,
      waiting_since: null,
      last_review_id: null,
      outcome: null,
      converged_at: null,
      updated_at: ts,
    });
  } else {
    await table.insert({
      pr_key: parsed.prKey,
      repo: parsed.repo,
      number: parsed.number,
      url: parsed.url,
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
    }));
}

/** One review-ready poll pass (SPEC §10): for every PR waiting on a review, fetch its GitHub
 * reviews (via the host `gh` CLI or a token — see `app/github.ts`) and, on a fresh one,
 * correlate a `review-ready` message to resume the loop. */
export async function pollOnce(data: DataLayer, engine: EngineClient, token: string) {
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
