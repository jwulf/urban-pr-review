// pr.persist-escalation — records the round that raised an escalation and opens
// an escalation row for a human to answer. Handles both the agent-raised path
// (status = needs_input | blocked) and the MAX_ROUNDS guard (status = blocked,
// question set by the process). Returns `escalationId` for the UI.
import { defineWorker } from "@nanobpm/worker";

interface In {
  prKey: string;
  round: number;
  status?: string;
  summary?: string;
  question?: string;
}

defineWorker<In>({
  type: "pr.persist-escalation",
  async handle(job, ctx) {
    const { prKey, round, status = "needs_input", summary = "", question = "" } =
      job.variables;
    const kind = status === "needs_input" ? "question" : "blocker";
    const now = new Date().toISOString();
    const db = await ctx.data("app");

    await db.exec(
      `INSERT INTO rounds (pr_key, round_no, status, summary, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [prKey, round, status, summary, now, now],
    );
    const res = await db.exec(
      `INSERT INTO escalations (pr_key, round_no, kind, question, status, asked_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
      [prKey, round, kind, question || "(no question provided)", now],
    );
    await db.exec(
      `UPDATE pull_requests
         SET status = 'escalated', current_round = ?, updated_at = ?
       WHERE pr_key = ?`,
      [round, now, prKey],
    );

    return { escalationId: Number(res.lastInsertId ?? 0) };
  },
});
