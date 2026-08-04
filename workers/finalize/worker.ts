// pr.finalize — the PR has converged. Record the final round and either (a) hand off to the
// merge stage (start the `merge-loop` process and park the PR in `waiting_deps`) when auto-merge
// is on, or (b) close the PR out as `converged` (review-only mode).
import type { AppJobHandler } from "@nanobpm/urban";
import { AUTO_MERGE, startMerge } from "../../app/service.ts";

// Extends Record so the declared fields are typed while the job may still carry
// other process variables (e.g. io.nanobpm.agentResult, read by transcriptOf).
interface In extends Record<string, unknown> {
  prKey: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  round: number;
  summary?: string;
}

const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
function transcriptOf(vars: Record<string, unknown>): string | null {
  const env = vars[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  return typeof env?.output === "string" ? env.output : null;
}

const handler: AppJobHandler<In> = async (job, app) => {
  // `summary` is left undefined when absent so the write boundary omits it: the
  // nullable `rounds.summary` stays NULL and `pull_requests.outcome` is untouched
  // rather than being coerced to "".
  const { prKey, repo, prNumber, prUrl, round, summary } = job.variables;
  const now = new Date().toISOString();

  await app.data.table("rounds", "id").insert({
    pr_key: prKey,
    round_no: round,
    status: "converged",
    summary,
    transcript: transcriptOf(job.variables),
    started_at: now,
    ended_at: now,
  });

  // Converged bookkeeping is recorded in both modes; `outcome`/`converged_at` capture the
  // review result. In auto-merge mode the row's *status* moves into the merge stage rather than
  // resting at `converged`, so the merge poller starts watching immediately.
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status: AUTO_MERGE ? "waiting_deps" : "converged",
    current_round: round,
    outcome: summary,
    converged_at: now,
    updated_at: now,
    open_escalation_id: null,
    open_escalation_question: null,
  });

  if (AUTO_MERGE) {
    // Start the separate merge-loop instance (keyed on prKey) that lands the PR. Best-effort:
    // a failure here must not fail the convergence finalize — the PR is already recorded
    // converged, and a human/operator can (re)start merge. Log and move on.
    try {
      await startMerge(app.data, app.engine, { repo, number: prNumber, url: prUrl, prKey, round });
    } catch (err) {
      app.log("error", `finalize: could not start merge-loop for ${prKey}`, { err: String(err) });
    }
  }

  return {};
};

export default handler;
