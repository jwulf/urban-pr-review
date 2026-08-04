// pr.select-wave — pick the tasks to run in the current wave (issue #20).
//
// The plan-fanout wave loop calls this before each parallel `implement` fan-out. It loads
// `plan_tasks` for the plan, keeps the still-`pending` tasks whose `wave` equals the process's
// `currentWave`, and emits them as `waveTasks: [{ id, title, prompt }]` — the multi-instance
// input collection.
//
// A task is only runnable when EVERY dependency it declared has an `opened` PR. If any
// dependency ended `blocked` / `skipped` (or is otherwise not opened), the dependent can't be
// built: this worker marks it `skipped` (recording which deps were unmet) and excludes it from
// the wave, so the failure cascades forward instead of dispatching an agent that can't succeed.
//
// Emitting an empty `waveTasks` is fine: the MI activity over an empty collection completes
// immediately (the same 0-task path the flat fan-out already relied on).
import type { AppJobHandler } from "@nanobpm/urban";
import { planTaskDeps, planTasks } from "../../app/plan.ts";

interface In extends Record<string, unknown> {
  planKey: string;
  currentWave: number;
}
interface WaveTaskOut {
  id: string;
  title: string;
  prompt: string;
}
interface Out extends Record<string, unknown> {
  waveTasks: WaveTaskOut[];
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  const currentWave = Number(job.variables.currentWave ?? 0);
  const ts = new Date().toISOString();

  const taskTable = planTasks(app.data);
  const rows = await taskTable.find({ plan_key: planKey });
  const statusById = new Map<string, string>();
  for (const r of rows) statusById.set(r.task_id, r.status);

  const deps = await planTaskDeps(app.data).find({ plan_key: planKey });
  const depsByTask = new Map<string, string[]>();
  for (const d of deps) {
    const list = depsByTask.get(d.task_id) ?? [];
    list.push(d.depends_on_task_id);
    depsByTask.set(d.task_id, list);
  }

  const waveTasks: WaveTaskOut[] = [];
  for (const r of rows) {
    if ((r.wave ?? 0) !== currentWave) continue;
    // Only fresh tasks are dispatchable; a retry of this wave must not re-run resolved ones.
    if (r.status !== "pending") continue;

    const unmet = (depsByTask.get(r.task_id) ?? []).filter((d) => statusById.get(d) !== "opened");
    if (unmet.length > 0) {
      await taskTable.update(r.id, {
        status: "skipped",
        summary: `dependency not opened: ${unmet.join(", ")}`,
        updated_at: ts,
      });
      continue;
    }
    waveTasks.push({ id: r.task_id, title: r.title ?? r.task_id, prompt: r.prompt ?? "" });
  }

  return { waveTasks };
};

export default handler;
