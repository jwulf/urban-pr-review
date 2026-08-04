// pr.record-plan — persists the plan the `senior:plan` agent emitted and normalizes the task
// list so the parallel multi-instance fan-out has stable, id-bearing items.
//
// The planner emits `{ tasks: [{ id?, title?, prompt }] }`. This worker:
//   • assigns each task a stable `id` (planner slug, else `t<index>`) and an index,
//   • writes one `plan_tasks` row per task (status `pending`),
//   • records the task count and moves the plan to `dispatched`,
//   • re-emits the normalized `tasks` so the MI activity iterates the canonical list
//     (input collection `=tasks`) and its output collection aligns by index.
import type { AppJobHandler } from "@nanobpm/urban";

interface RawTask {
  id?: unknown;
  title?: unknown;
  prompt?: unknown;
}
interface In extends Record<string, unknown> {
  planKey: string;
  tasks?: RawTask[];
  note?: string;
}
interface NormalTask {
  id: string;
  title: string;
  prompt: string;
}
interface Out extends Record<string, unknown> {
  tasks: NormalTask[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const { planKey, note } = job.variables;
  const raw = Array.isArray(job.variables.tasks) ? job.variables.tasks : [];
  const ts = new Date().toISOString();

  const tasks: NormalTask[] = raw.map((t, i) => {
    const id = str(t?.id).trim() || `t${i + 1}`;
    return { id, title: str(t?.title).trim() || id, prompt: str(t?.prompt) };
  });

  // Idempotency: a retry (or re-run) of this job must not duplicate `plan_tasks`
  // rows for the same plan. Clear any tasks already recorded for this plan before
  // re-inserting the normalized list.
  const existing = await app.data.table("plan_tasks", "id").find({ plan_key: planKey });
  for (const row of existing as Array<{ id: number }>) {
    await app.data.table("plan_tasks", "id").delete(row.id);
  }

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    await app.data.table("plan_tasks", "id").insert({
      plan_key: planKey,
      task_index: i,
      task_id: t.id,
      title: t.title,
      prompt: t.prompt,
      status: "pending",
      created_at: ts,
      updated_at: ts,
    });
  }

  const patch: Record<string, unknown> = {
    status: tasks.length > 0 ? "dispatched" : "done",
    task_count: tasks.length,
    updated_at: ts,
  };
  if (tasks.length === 0) patch.outcome = note ? str(note) : "planner emitted no tasks";
  await app.data.table("plans", "plan_key").update(planKey, patch);

  // Re-emit the canonical list so `=tasks` fans out the normalized items.
  return { tasks };
};

export default handler;
