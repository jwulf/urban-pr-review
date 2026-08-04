// pr.record-results — the fleet has finished. The parallel multi-instance activity aggregated
// one result per task into `results` (index-aligned with the plan's tasks). This worker:
//   • records each slice's outcome (status / summary / PR) on its `plan_tasks` row,
//   • HANDS OFF each opened PR into the review-convergence loop (reusing submitPr), so a PR
//     the fleet produced is driven to convergence exactly as a hand-submitted one,
//   • marks the plan `done`.
//
// Results align to tasks by index (the engine writes the MI output collection at each child's
// loop index, regardless of completion order), so `results[i]` is the outcome of the task whose
// `task_index` is `i`.
import type { AppJobHandler } from "@nanobpm/urban";
import { parsePr, submitPr } from "../../app/service.ts";

interface Result {
  status?: unknown;
  summary?: unknown;
  pr?: unknown;
}
interface In extends Record<string, unknown> {
  planKey: string;
  results?: Result[];
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

// The implementation agent reports one of these (see prompts/feature.md). Anything
// else — including a missing status — is treated as `blocked`: we must not assume a
// PR was opened, and we only hand off/persist a PR when the status is `opened`.
const ALLOWED_STATUSES = new Set(["opened", "blocked", "skipped"]);

const handler: AppJobHandler<In> = async (job, app) => {
  const { planKey } = job.variables;
  const results = Array.isArray(job.variables.results) ? job.variables.results : [];
  const ts = new Date().toISOString();

  const rows = await app.data.table("plan_tasks", "id").find({ plan_key: planKey });
  const byIndex = new Map<number, { id: number }>();
  for (const r of rows as Array<{ id: number; task_index: number }>) byIndex.set(r.task_index, r);

  let opened = 0;
  for (let i = 0; i < results.length; i++) {
    const res = results[i] ?? {};
    const rawStatus = str(res.status);
    const status = rawStatus && ALLOWED_STATUSES.has(rawStatus) ? rawStatus : "blocked";
    const summary = str(res.summary);
    const prRef = str(res.pr);
    // Only trust a PR ref when the agent reports it actually opened one.
    const parsed = status === "opened" && prRef ? parsePr(prRef) : null;

    const row = byIndex.get(i);
    if (row) {
      const patch: Record<string, unknown> = { status, updated_at: ts };
      if (summary !== undefined) patch.summary = summary;
      if (parsed?.prKey) patch.pr_key = parsed.prKey;
      await app.data.table("plan_tasks", "id").update(row.id, patch);
    }

    // Handoff: enroll each opened PR into the convergence loop. Best-effort — a
    // failed handoff must not fail the plan; the PR is recorded and can be
    // resubmitted. submitPr is idempotent on prKey (a PR already converging is a
    // no-op), so a retry of this worker won't double-start.
    if (parsed) {
      try {
        await submitPr(app.data, app.engine, parsed);
        opened++;
      } catch (err) {
        app.log("error", `record-results: handoff failed for ${parsed.prKey}`, { err: String(err) });
      }
    }
  }

  const planPatch: Record<string, unknown> = { status: "done", updated_at: ts };
  // When there are no results, `record-plan` has already set a meaningful outcome
  // (e.g. the planner's note that it emitted no tasks). Preserve it rather than
  // overwriting with a "0 PR(s) dispatched" message.
  if (results.length > 0) {
    planPatch.outcome = `${opened} PR(s) dispatched to convergence`;
  }
  await app.data.table("plans", "plan_key").update(planKey, planPatch);

  return {};
};

export default handler;
