// pr.persist-escalation — records the round that raised an escalation and opens an escalation
// row for a human to answer. Handles both the agent-raised path (status = needs_input | blocked)
// and the MAX_ROUNDS guard (status = blocked, question set by the process). Returns
// `escalationId` for the UI.
import type { AppJobHandler } from "@nanobpm/urban";

// Extends Record so the declared fields are typed while the job may still carry
// other process variables (e.g. io.nanobpm.agentResult, read by transcriptOf).
interface In extends Record<string, unknown> {
  prKey: string;
  round: number;
  status?: string;
  summary?: string;
  question?: string;
  // False on the "review stalled" arm: `persist-round` already recorded this `round` as
  // `addressed`, so this escalation must not insert a second `rounds` row for the same
  // `pr_key`/`round_no` (which would record one round as both addressed and blocked). Absent
  // on the agent-raised / max-rounds arms, where no prior round row exists — so it defaults on.
  recordRound?: boolean;
}

// A string variable, or undefined when it is absent, empty, or whitespace-only.
// The write boundary owns *type* defaults (undefined -> column DEFAULT/NULL); this
// owns a *domain* rule: a blank prompt or status counts as "missing" so it can't
// reach the escalation control flow or the UI answer form.
function nonBlank(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
function transcriptOf(vars: Record<string, unknown>): string | null {
  const env = vars[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  return typeof env?.output === "string" ? env.output : null;
}

const handler: AppJobHandler<In> = async (job, app) => {
  const { prKey, round, summary } = job.variables;
  // `status` drives the escalation kind (control flow); a blank/absent status is an
  // unclassified escalation -> a question needing input. `question` is denormalised
  // onto pull_requests below and bound by the UI answer form, so it must be a
  // concrete, non-blank value. `summary` is left undefined so the write boundary
  // omits it and the nullable column stays NULL.
  const status = nonBlank(job.variables.status) ?? "needs_input";
  // A blank question must never open an escalation: it would surface a non-actionable
  // "(no question provided)" placeholder in the answer form (the empty escalations on
  // Magikcraft/nano-bpm #597/#599). Every legitimate arm sets a concrete question — the agent
  // contract requires one for needs_input/blocked, and the max-rounds + review-timeout arms set a
  // literal via the model. A blank here means a prompt-less / no-result round fell through the
  // `gw-status` default; fail loudly (mirroring the sibling `persist-task-escalation`) so it
  // surfaces as an incident rather than parking an unanswerable escalation.
  const question = nonBlank(job.variables.question);
  if (!question) {
    throw new Error(
      "persist-escalation: missing question — refusing to open an unanswerable escalation (round returned no actionable status)",
    );
  }
  const kind = status === "needs_input" ? "question" : "blocker";
  const now = new Date().toISOString();
  const transcript = transcriptOf(job.variables);

  // Skip the round insert when the caller already recorded this round (the "review stalled"
  // arm runs after `persist-round`): re-inserting would duplicate the `pr_key`/`round_no` row.
  if (job.variables.recordRound !== false) {
    await app.data.table("rounds", "id").insert({
      pr_key: prKey,
      round_no: round,
      status,
      summary,
      transcript,
      started_at: now,
      ended_at: now,
    });
  }
  const escalationId = await app.data.table("escalations", "id").insert({
    pr_key: prKey,
    round_no: round,
    kind,
    question,
    transcript,
    status: "open",
    asked_at: now,
  });
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status: "escalated",
    current_round: round,
    updated_at: now,
    open_escalation_id: Number(escalationId),
    open_escalation_question: question,
  });

  return { escalationId: Number(escalationId) };
};

export default handler;
