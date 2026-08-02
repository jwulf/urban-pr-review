// pr.persist-escalation — records the round that raised an escalation and opens an escalation
// row for a human to answer. Handles both the agent-raised path (status = needs_input | blocked)
// and the MAX_ROUNDS guard (status = blocked, question set by the process). Returns
// `escalationId` for the UI.
import type { AppJobHandler } from "@nanobpm/urban";

interface In {
  prKey: string;
  round: number;
  status?: string;
  summary?: string;
  question?: string;
}

const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
function transcriptOf(vars: Record<string, unknown>): string | null {
  const env = vars[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  return typeof env?.output === "string" ? env.output : null;
}

const handler: AppJobHandler = async (job, app) => {
  const { prKey, round, status = "needs_input", summary = "", question = "" } =
    job.variables as unknown as In;
  const kind = status === "needs_input" ? "question" : "blocker";
  const now = new Date().toISOString();
  const transcript = transcriptOf(job.variables);

  await app.data.table("rounds", "id").insert({
    pr_key: prKey,
    round_no: round,
    status,
    summary,
    transcript,
    started_at: now,
    ended_at: now,
  });
  const escalationId = await app.data.table("escalations", "id").insert({
    pr_key: prKey,
    round_no: round,
    kind,
    question: question || "(no question provided)",
    transcript,
    status: "open",
    asked_at: now,
  });
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status: "escalated",
    current_round: round,
    updated_at: now,
    open_escalation_id: Number(escalationId),
    open_escalation_question: question || "(no question provided)",
  });

  return { escalationId: Number(escalationId) };
};

export default handler;
