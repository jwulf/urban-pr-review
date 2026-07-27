// pr.persist-escalation — records the round that raised an escalation and opens
// an escalation row for a human to answer. Handles both the agent-raised path
// (status = needs_input | blocked) and the MAX_ROUNDS guard (status = blocked,
// question set by the process). Returns `escalationId` for the UI.
import { defineWorker } from "@nanobpm/worker";
import { openDomain } from "@nanobpm/domain";

const db = await openDomain("app");

interface In {
  prKey: string;
  round: number;
  status?: string;
  summary?: string;
  question?: string;
}

defineWorker({
  type: "pr.persist-escalation",
  async handle(job) {
    const { prKey, round, status = "needs_input", summary = "", question = "" } =
      job.variables as unknown as In;
    const kind = status === "needs_input" ? "question" : "blocker";
    const now = new Date().toISOString();

    await db.rounds.insert({
      pr_key: prKey, round_no: round, status, summary,
      started_at: now, ended_at: now,
    });
    const escalationId = await db.escalations.insert({
      pr_key: prKey, round_no: round, kind,
      question: question || "(no question provided)",
      status: "open", asked_at: now,
    });
    await db.pull_requests.update(prKey, {
      status: "escalated", current_round: round, updated_at: now,
    });

    return { escalationId: Number(escalationId) };
  },
});
