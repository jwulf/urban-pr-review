// pr.finalize — the PR has converged. Record the final round and close the PR out.
import { defineWorker } from "@nanobpm/worker";

interface In {
  prKey: string;
  round: number;
  summary?: string;
}

defineWorker<In>({
  type: "pr.finalize",
  async handle(job, ctx) {
    const { prKey, round, summary = "" } = job.variables;
    const now = new Date().toISOString();
    const db = await ctx.data("app");

    await db.exec(
      `INSERT INTO rounds (pr_key, round_no, status, summary, started_at, ended_at)
       VALUES (?, ?, 'converged', ?, ?, ?)`,
      [prKey, round, summary, now, now],
    );
    await db.exec(
      `UPDATE pull_requests
         SET status = 'converged',
             current_round = ?,
             outcome = ?,
             converged_at = ?,
             updated_at = ?
       WHERE pr_key = ?`,
      [round, summary, now, now, prKey],
    );

    return {};
  },
});
