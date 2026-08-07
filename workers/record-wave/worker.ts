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
import { type PlanTask, planTaskDeps, planTasks, plans } from "../../app/plan.ts";
import { parsePr, submitPr } from "../../app/service.ts";
import { parseTaskDelta, recordTaskDelta } from "../../app/taskDelta.ts";
import { appendEntry } from "../../app/blackboard.ts";

interface Result {
  status?: unknown;
  summary?: unknown;
  pr?: unknown;
  delta?: unknown;
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

// Coerce a wave index/count to a non-negative integer, falling back to 0. A NaN here would make
// `nextWave < waveCount` mis-evaluate and end the loop early, leaving tasks `pending`.
const toWave = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  const currentWave = toWave(job.variables.currentWave);
  const waveCount = toWave(job.variables.waveCount);
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
    // A keyless "opened" is effectively blocked: downstream waves gate on `opened` meaning
    // "this dependency has an opened PR", so an "opened" with no usable PR key must NOT satisfy
    // a dependant (it would let dependents run with a phantom, un-mergeable dependency).
    const effectiveStatus = status === "opened" && !parsed ? "blocked" : status;

    const row = byTaskId.get(taskId);
    if (row) {
      const patch: Partial<PlanTask> = { status: effectiveStatus, updated_at: ts };
      if (summary !== undefined) patch.summary = summary;
      if (parsed?.prKey) {
        patch.pr_key = parsed.prKey;
        // Keep the in-memory row current so a same-wave dependant (rare) sees the PR key.
        row.pr_key = parsed.prKey;
      }
      await taskTable.update(row.id, patch);
    }

    // D5 (issue #55): capture the agent's structured scope/impl-change delta, then broadcast the
    // file/constraint facts onto the D4 coordination blackboard so later waves + the operator see
    // them (and D2 conflict-scan can consume them). Both are best-effort and idempotent — a failed
    // or retried delta write must never fail the wave. `recordTaskDelta` upserts per (plan, task);
    // the blackboard posts are dedupe-keyed, so a worker retry is a no-op.
    const delta = parseTaskDelta(res.delta);
    if (delta) {
      try {
        await recordTaskDelta(app.data, planKey, taskId, delta, { wave: currentWave });
        if (delta.newlyTouches.length > 0) {
          const why = delta.contractChange ?? delta.constraint ??
            `${taskId} now also edits ${delta.newlyTouches.join(", ")}`;
          await appendEntry(app.data, planKey, {
            author_task: taskId,
            kind: "file-claim",
            files: delta.newlyTouches,
            body: why,
            wave: currentWave,
            dedupe_key: `delta:${taskId}:touch`,
          });
        }
        const constraintBody = [delta.contractChange, delta.constraint].filter(Boolean).join(" — ");
        if (constraintBody) {
          await appendEntry(app.data, planKey, {
            author_task: taskId,
            kind: "constraint-change",
            body: delta.affectsTasks.length
              ? `${constraintBody} (affects: ${delta.affectsTasks.join(", ")})`
              : constraintBody,
            wave: currentWave,
            dedupe_key: `delta:${taskId}:constraint`,
          });
        }
      } catch (err) {
        app.log("error", `record-wave: recording delta for ${taskId} failed`, {
          err: String(err),
        });
      }
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
  const hasMoreWaves = nextWave < waveCount;

  // Wave-merge barrier: when another wave follows, park the plan-fanout instance at the
  // `wait-wave-merged` catch event until THIS wave's opened PRs have MERGED (not merely opened).
  // `gate_wave` is that durable marker; the poller (`pollWaveGates`) clears it and publishes
  // `wave-merged` once the wave has landed. Clear it on the final wave so a re-planned issue can't
  // inherit a stale gate. Best-effort: a failed marker write must not fail the wave (the poller
  // reconciles from `plan_tasks`/`pull_requests`), but the loop still relies on it to know which
  // wave to watch, so we log a failure loudly.
  try {
    await plans(app.data).update(planKey, {
      gate_wave: hasMoreWaves ? currentWave : null,
      updated_at: ts,
    });
  } catch (err) {
    app.log("error", `record-wave: arming wave gate failed for ${planKey}`, { err: String(err) });
  }

  return { currentWave: nextWave, hasMoreWaves };
};

export default handler;
