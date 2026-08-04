// pr.record-wave — the current wave's parallel `implement` fan-out has finished (issue #20).
//
// The MI activity aggregated one result per dispatched task into `waveResults`, index-aligned
// with the `waveTasks` `select-wave` emitted (the engine writes each child's output at its loop
// index, regardless of completion order). This worker:
//   • records each slice's outcome (`opened` / `blocked`) on its `plan_tasks` row,
//   • HANDS OFF each opened PR into the review-convergence loop (reusing `submitPr`), declaring
//     its dependency tasks' PRs as `dependsOn` — so the merge-ordering DAG (`pr_dependencies`)
//     matches the task DAG for free,
//   • advances `currentWave` and emits `hasMoreWaves` so the loop either runs the next wave
//     (`select-wave`) or falls through to `record-results`.
//
// Enrollment lives here (not in the finalizer) so a PR is enrolled the moment its wave lands —
// and, crucially, so a later wave's `dependsOn` can reference the PR keys earlier waves produced.
import type { AppJobHandler } from "@nanobpm/urban";
import { type PlanTask, planTaskDeps, planTasks } from "../../app/plan.ts";
import { parsePr, submitPr } from "../../app/service.ts";

interface Result {
  status?: unknown;
  summary?: unknown;
  pr?: unknown;
}
interface WaveTaskIn {
  id?: unknown;
}
interface In extends Record<string, unknown> {
  planKey: string;
  currentWave: number;
  waveCount: number;
  waveTasks?: WaveTaskIn[];
  waveResults?: Result[];
}
interface Out extends Record<string, unknown> {
  currentWave: number;
  hasMoreWaves: boolean;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

// The implementation agent reports one of these (see prompts/feature.md). Anything else —
// including a missing status — is treated as `blocked`: we must not assume a PR was opened,
// and we only hand off / persist a PR when the status is `opened`.
const ALLOWED_STATUSES = new Set(["opened", "blocked", "skipped"]);

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  const currentWave = Number(job.variables.currentWave ?? 0);
  const waveCount = Number(job.variables.waveCount ?? 0);
  const waveTasks = Array.isArray(job.variables.waveTasks) ? job.variables.waveTasks : [];
  const results = Array.isArray(job.variables.waveResults) ? job.variables.waveResults : [];
  const ts = new Date().toISOString();

  const taskTable = planTasks(app.data);
  const rows = await taskTable.find({ plan_key: planKey });
  const byTaskId = new Map<string, PlanTask>();
  for (const r of rows) byTaskId.set(r.task_id, r);

  const deps = await planTaskDeps(app.data).find({ plan_key: planKey });
  const depsByTask = new Map<string, string[]>();
  for (const d of deps) {
    const list = depsByTask.get(d.task_id) ?? [];
    list.push(d.depends_on_task_id);
    depsByTask.set(d.task_id, list);
  }

  for (let i = 0; i < waveTasks.length; i++) {
    const taskId = str((waveTasks[i] ?? {}).id);
    if (!taskId) continue;
    const res = results[i] ?? {};
    const rawStatus = str(res.status);
    const status = rawStatus && ALLOWED_STATUSES.has(rawStatus) ? rawStatus : "blocked";
    const summary = str(res.summary);
    const prRef = str(res.pr);
    // Only trust a PR ref when the agent reports it actually opened one.
    const parsed = status === "opened" && prRef ? parsePr(prRef) : null;

    const row = byTaskId.get(taskId);
    if (row) {
      const patch: Partial<PlanTask> = { status, updated_at: ts };
      if (summary !== undefined) patch.summary = summary;
      if (parsed?.prKey) {
        patch.pr_key = parsed.prKey;
        // Keep the in-memory row current so a same-wave dependant (rare) sees the PR key.
        row.pr_key = parsed.prKey;
      }
      await taskTable.update(row.id, patch);
    }

    // Handoff: enroll each opened PR into the convergence loop. Best-effort — a failed handoff
    // must not fail the wave; the PR is recorded and can be resubmitted. `submitPr` is idempotent
    // on prKey (a PR already converging is a no-op), so a retry of this worker won't double-start.
    if (parsed) {
      const depPrKeys: string[] = [];
      for (const depTaskId of depsByTask.get(taskId) ?? []) {
        const depRow = byTaskId.get(depTaskId);
        if (depRow?.pr_key) depPrKeys.push(depRow.pr_key);
      }
      try {
        await submitPr(app.data, app.engine, parsed, depPrKeys);
      } catch (err) {
        app.log("error", `record-wave: handoff failed for ${parsed.prKey}`, {
          err: String(err),
        });
      }
    }
  }

  const nextWave = currentWave + 1;
  return { currentWave: nextWave, hasMoreWaves: nextWave < waveCount };
};

export default handler;
