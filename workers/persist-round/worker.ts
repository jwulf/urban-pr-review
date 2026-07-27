// pr.persist-round — records an "addressed" round and parks the PR in
// `waiting_review` so the poller starts watching for the next review.
import { defineWorker } from "@nanobpm/worker";

interface In {
  prKey: string;
  round: number;
  status?: string;
  summary?: string;
}

defineWorker<In>({
  type: "pr.persist-round",
  async handle(job, ctx) {
    const { prKey, round, status = "addressed", summary = "" } = job.variables;
    const now = new Date().toISOString();
    const db = await ctx.data("app");

    await db.exec(
      `INSERT INTO rounds (pr_key, round_no, status, summary, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [prKey, round, status, summary, now, now],
    );
    await db.exec(
      `UPDATE pull_requests
         SET status = 'waiting_review',
             current_round = ?,
             waiting_since = ?,
             updated_at = ?
       WHERE pr_key = ?`,
      [round, now, now, prKey],
    );

    return {};
  },
});
