// pr.record-trial-merge — persist the D3 trial-merge gate result and shape the BPMN gateway vars.
// Only `suite-failed` escalates. `clean` and textual `merge-conflict` proceed; D2/D6 own textual
// conflict ordering, while D3 owns clean-merge/combined-suite-red semantic conflicts.
import type { AppJobHandler } from "@nanobpm/urban";
import {
  recordTrialMergeAudit,
  trialMergeDecision,
  trialMergeTaskId,
  type TrialMergeResult,
} from "../../app/trialMerge.ts";

interface In extends Record<string, unknown> {
  planKey: string;
  currentWave?: unknown;
  trialMergeWave?: unknown;
  waveOpenHeads?: unknown;
  result?: unknown;
  conflicts?: unknown;
  failing?: unknown;
  summary?: unknown;
}
interface Out extends Record<string, unknown> {
  trialMergeRed: boolean;
  question?: string;
  task?: { id: string; title: string };
  summary?: string;
}

const RESULTS = new Set<TrialMergeResult>(["clean", "merge-conflict", "suite-failed"]);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
const waveNo = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

function parseResult(v: unknown): TrialMergeResult {
  return typeof v === "string" && RESULTS.has(v as TrialMergeResult) ? (v as TrialMergeResult) : "suite-failed";
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  const wave = waveNo(job.variables.trialMergeWave ?? job.variables.currentWave);
  const result = parseResult(job.variables.result);
  const summary = str(job.variables.summary) ??
    (result === "suite-failed" ? "Trial merge suite failed or returned no machine-readable result" : result);
  const rawJobKey = (job as { key?: unknown }).key;
  const jobKey = rawJobKey == null ? null : String(rawJobKey);

  try {
    await recordTrialMergeAudit(app.data, {
      planKey,
      wave,
      result,
      heads: job.variables.waveOpenHeads,
      conflicts: job.variables.conflicts,
      failing: job.variables.failing,
      summary,
      jobKey,
    });
  } catch (err) {
    app.log("error", `record-trial-merge: audit persist failed for ${planKey} wave ${wave}`, { err: String(err) });
  }

  const trialMergeRed = trialMergeDecision(result) === "escalate";
  if (!trialMergeRed) return { trialMergeRed, summary };

  const failing = Array.isArray(job.variables.failing) && job.variables.failing.length > 0
    ? ` Failing: ${safeJson(job.variables.failing).slice(0, 1000)}`
    : "";
  return {
    trialMergeRed,
    summary,
    task: { id: trialMergeTaskId(wave), title: `Trial merge gate for wave ${wave}` },
    question: `${summary}${failing}\n\nD3 found a semantic conflict: the PR heads merged cleanly but the combined suite failed. Decide the design fix, update the PR heads, then answer to rerun the trial merge; answer exactly \"proceed\" only to override and continue without rerunning.`,
  };
};

export default handler;
export { parseResult };
