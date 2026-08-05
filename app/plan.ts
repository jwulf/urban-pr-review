// urban-pr-review — planning fan-out logic (issue #14).
//
// A planning agent (`senior:plan`) decomposes an issue into a list of tasks; the
// `plan-fanout` process then fans those tasks out over a parallel multi-instance
// service task (`senior:feature`), one implementation agent per task. Each agent
// opens a PR, which `record-results` enrolls into the existing convergence loop.
//
// This module is the seam the start actions and the record workers call: it owns
// issue parsing, the plan/plan_tasks row shapes, the prompt assets, and starting
// the process. Data access goes through the record gateway (`data.table`), never
// hand-written SQL — matching app/service.ts.
import type { DataLayer, EngineClient } from "@nanobpm/urban";

/** The BPMN process this module drives (resources/processes/plan-fanout.bpmn). */
export const PLAN_PROCESS_ID = "plan-fanout";

const now = () => new Date().toISOString();

// Prompt assets, read once at module load and carried on each new instance (as the
// review prompt is in app/service.ts). Host-agnostic: Deno inside a compiled binary,
// else node:fs under Node.
async function readAsset(path: string): Promise<string> {
  try {
    const g = globalThis as { Deno?: { readTextFile(p: string): Promise<string> } };
    return g.Deno?.readTextFile
      ? await g.Deno.readTextFile(path)
      : await (await import("node:fs/promises")).readFile(path, "utf8");
  } catch {
    return "";
  }
}
const PLAN_PROMPT = await readAsset("prompts/plan.md");
const FEATURE_PROMPT = await readAsset("prompts/feature.md");
const PLAN_REVIEW_PROMPT = await readAsset("prompts/plan-review.md");

export interface Plan {
  plan_key: string;
  repo: string;
  issue_number: number;
  issue_url: string;
  title: string | null;
  status: string;
  task_count: number;
  process_key: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanTask {
  id: number;
  plan_key: string;
  task_index: number;
  task_id: string;
  title: string | null;
  prompt: string | null;
  status: string;
  pr_key: string | null;
  summary: string | null;
  wave: number | null;
  created_at: string;
  updated_at: string;
}

export const plans = (data: DataLayer) => data.table<Plan>("plans", "plan_key");
export const planTasks = (data: DataLayer) => data.table<PlanTask>("plan_tasks", "id");

/** One dependency edge in the plan DAG (issue #20): `task_id` waits for `depends_on_task_id`.
 * Keyed on `plan_key` so a single delete clears a plan's whole edge set (as pr_dependencies). */
export interface PlanTaskDep {
  plan_key: string;
  task_id: string;
  depends_on_task_id: string;
}
export const planTaskDeps = (data: DataLayer) =>
  data.table<PlanTaskDep>("plan_task_deps", "plan_key");

/** One adversarial plan-review round (006_plan_review.sql): the `senior:plan-review` agent's
 * verdict on the plan before fan-out. Append-only within a plan run; the current round is
 * `count(plan_reviews)`. Re-planning a finished issue clears the prior rows (see startPlan) so
 * the round index restarts at 0.
 * `job_key` is the engine job key that wrote the row — an idempotency guard so a retried job
 * (crash/timeout after the insert) reuses its row instead of appending a duplicate round. */
export interface PlanReview {
  plan_key: string;
  round: number;
  approved: number;
  findings: string | null;
  created_at: string;
  job_key: string | null;
}
export const planReviews = (data: DataLayer) => data.table<PlanReview>("plan_reviews", "plan_key");

/** Read a positive-integer env override, falling back when unset/blank/invalid. A bad value
 * (e.g. "", "abc", "0", "2.5") must NOT silently become `NaN`/`0` — that would make the round
 * cap `round + 1 >= cap` always false and allow an unbounded revise loop. */
export function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Max adversarial plan-review rounds before the fan-out proceeds regardless (so a reviewer that
 * never approves can't dead-lock the plan). The last round's findings are still recorded. */
export const MAX_PLAN_REVIEW_ROUNDS = positiveIntEnv("NANO_PLAN_REVIEW_ROUNDS", 3);

/** A plan is "done" in exactly these states; everything else (planning, dispatched)
 * is in flight. The cancel guard and the active view key off this. */
export const PLAN_TERMINAL_STATUSES: readonly string[] = ["done", "failed", "abandoned"];

export interface ParsedIssue {
  repo: string;
  number: number;
  url: string;
  planKey: string;
}

/** Parse "owner/repo#123" or a canonical issue URL into its parts. Mirrors parsePr
 * (app/service.ts) but for the /issues/ path. */
export function parseIssue(input: string): ParsedIssue | null {
  const s = input.trim();
  let m = s.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    const number = Number(m[3]);
    return { repo, number, url: `https://github.com/${repo}/issues/${number}`, planKey: `${repo}#${number}` };
  }
  m = s.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (m) {
    const repo = m[1];
    const number = Number(m[2]);
    return { repo, number, url: `https://github.com/${repo}/issues/${number}`, planKey: `${repo}#${number}` };
  }
  return null;
}

/** Register a plan row (if new) and start the plan-fanout process. Idempotent on
 * planKey: a plan already in flight is not restarted. */
export async function startPlan(data: DataLayer, engine: EngineClient, parsed: ParsedIssue) {
  const table = plans(data);
  const existing = await table.get(parsed.planKey);
  if (existing && !PLAN_TERMINAL_STATUSES.includes(existing.status)) {
    return { planKey: parsed.planKey, alreadyRunning: true };
  }
  const ts = now();
  if (existing) {
    // Re-plan a previously finished issue: clear the old tasks and start fresh.
    for (const t of await planTasks(data).find({ plan_key: parsed.planKey })) {
      await planTasks(data).delete(t.id);
    }
    // `plan_reviews` is append-only and the review round is derived from
    // `count(plan_reviews)`, so stale rows from the prior run would inflate the
    // next round index and trip `reviewExhausted` early (bypassing the gate).
    // Clear them here — the table is keyed on `plan_key`, so one delete drops the
    // whole set (mirrors how record-plan clears `plan_task_deps`).
    await planReviews(data).delete(parsed.planKey);
    await table.update(parsed.planKey, {
      status: "planning",
      task_count: 0,
      issue_url: parsed.url,
      outcome: null,
      updated_at: ts,
    });
  } else {
    await table.insert({
      plan_key: parsed.planKey,
      repo: parsed.repo,
      issue_number: parsed.number,
      issue_url: parsed.url,
      status: "planning",
      task_count: 0,
      created_at: ts,
      updated_at: ts,
    });
  }
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId: PLAN_PROCESS_ID,
    variables: {
      planKey: parsed.planKey,
      repo: parsed.repo,
      issue: parsed.planKey,
      issueNumber: parsed.number,
      issueUrl: parsed.url,
      planPrompt: PLAN_PROMPT,
      planReviewPrompt: PLAN_REVIEW_PROMPT,
      planFindings: null,
      featurePrompt: FEATURE_PROMPT,
    },
  });
  if (processInstanceKey != null) {
    await table.update(parsed.planKey, { process_key: String(processInstanceKey), updated_at: now() });
  }
  return { planKey: parsed.planKey, processKey: processInstanceKey };
}
