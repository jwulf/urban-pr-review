// pr.finalize — the PR has converged. Record the final round and close the PR out.
import type { AppJobHandler } from "@nanobpm/urban";

// Extends Record so the declared fields are typed while the job may still carry
// other process variables (e.g. io.nanobpm.agentResult, read by transcriptOf).
interface In extends Record<string, unknown> {
  prKey: string;
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
  const { prKey, round, summary } = job.variables;
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
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status: "converged",
    current_round: round,
    outcome: summary,
    converged_at: now,
    updated_at: now,
    open_escalation_id: null,
    open_escalation_question: null,
  });

  return {};
};

export default handler;
