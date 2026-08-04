// pr.record-results — the wave loop has finished; finalize the plan (issue #20).
//
// PR enrollment now happens per wave in `pr.record-wave` (so later waves can declare earlier
// waves' PRs as dependencies), leaving this worker as the terminal finalizer: it summarizes the
// plan from `plan_tasks` and marks it `done`. It reads no `results` — every task's outcome was
// already recorded by `record-wave` (opened / blocked) or `select-wave` (skipped).
import type { AppJobHandler } from "@nanobpm/urban";
import { planTasks } from "../../app/plan.ts";

interface In extends Record<string, unknown> {
  planKey: string;
}

const handler: AppJobHandler<In> = async (job, app) => {
  const { planKey } = job.variables;
  const ts = new Date().toISOString();

  const rows = await planTasks(app.data).find({ plan_key: planKey });
  const opened = rows.filter((r) => r.status === "opened").length;

  const patch: Record<string, unknown> = { status: "done", updated_at: ts };
  // When the planner emitted no tasks, `record-plan` already set a meaningful outcome (its
  // note) and moved the plan to `done`. Preserve it rather than overwriting with "0 PR(s)…".
  if (rows.length > 0) patch.outcome = `${opened} PR(s) dispatched to convergence`;
  await app.data.table("plans", "plan_key").update(planKey, patch);

  return {};
};

export default handler;
