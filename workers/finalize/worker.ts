// pr.finalize — the PR has converged. Record the final round and close the PR out.
import { defineWorker } from "@nanobpm/worker";
import { openDomain } from "@nanobpm/domain";

const db = await openDomain("app");

interface In {
  prKey: string;
  round: number;
  summary?: string;
}

const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
function transcriptOf(vars: Record<string, unknown>): string | undefined {
  const env = vars[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  return typeof env?.output === "string" ? env.output : undefined;
}

defineWorker({
  type: "pr.finalize",
  async handle(job) {
    const { prKey, round, summary = "" } = job.variables as unknown as In;
    const now = new Date().toISOString();

    await db.rounds.insert({
      pr_key: prKey, round_no: round, status: "converged", summary,
      transcript: transcriptOf(job.variables as Record<string, unknown>) ?? null,
      started_at: now, ended_at: now,
    });
    await db.pull_requests.update(prKey, {
      status: "converged", current_round: round,
      outcome: summary, converged_at: now, updated_at: now,
    });

    return {};
  },
});
