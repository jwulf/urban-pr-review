// pr.finalize — the PR has converged. Record the final round and close the PR out.
import type { AppJobHandler } from "@nanobpm/urban";

interface In {
  prKey: string;
  round: number;
  summary?: string;
}

const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
function transcriptOf(vars: Record<string, unknown>): string | null {
  const env = vars[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  return typeof env?.output === "string" ? env.output : null;
}

const handler: AppJobHandler = async (job, app) => {
  const { prKey, round, summary = "" } = job.variables as unknown as In;
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
