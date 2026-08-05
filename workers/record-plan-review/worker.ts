// pr.record-plan-review — record one adversarial plan-review round and decide whether the
// fan-out proceeds or the planner revises (issue: gate the plan before dispatch).
//
// The `senior:plan-review` agent critiqued the levelized plan and emitted `{ approved, findings }`.
// This worker:
//   • derives the current round from the append-only `plan_reviews` log (no counter variable),
//   • records this round's verdict + findings,
//   • decides the loop: `planApproved` (reviewer said yes) and `reviewExhausted` (the round cap
//     is reached, so we proceed regardless rather than dead-lock on a reviewer that never
//     approves), and re-emits the findings as `planFindings` so a revise round feeds the planner.
//
// The BPMN gateway proceeds to `select-wave` when `planApproved or reviewExhausted`, else loops
// back to `plan`. A missing/ambiguous `approved` is treated as NOT approved (revise) — but the
// round cap still bounds the loop, so the plan can never wedge.
import type { AppJobHandler } from "@nanobpm/urban";
import { MAX_PLAN_REVIEW_ROUNDS, planReviews } from "../../app/plan.ts";

interface In extends Record<string, unknown> {
  planKey: string;
  approved?: unknown;
  findings?: unknown;
}
interface Out extends Record<string, unknown> {
  planApproved: boolean;
  reviewExhausted: boolean;
  planFindings: string;
}

// Only an explicit boolean-true (or the string "true") approves; anything else — including a
// missing verdict — means revise. Bounded by the round cap, so this can't loop forever.
const isApproved = (v: unknown): boolean =>
  v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");

const str = (v: unknown): string =>
  typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  const approved = isApproved(job.variables.approved);
  const findings = str(job.variables.findings).trim();
  const ts = new Date().toISOString();

  const reviews = planReviews(app.data);
  const round = (await reviews.find({ plan_key: planKey })).length; // 0-based: next round index
  await reviews.insert({
    plan_key: planKey,
    round,
    approved: approved ? 1 : 0,
    findings: findings || null,
    created_at: ts,
  });

  // Exhausted once this round is the last permitted one (round is 0-based).
  const reviewExhausted = round + 1 >= MAX_PLAN_REVIEW_ROUNDS;
  if (!approved) {
    app.log(reviewExhausted ? "warn" : "info", `record-plan-review: ${planKey} round ${round}`, {
      approved,
      reviewExhausted,
    });
  }

  return { planApproved: approved, reviewExhausted, planFindings: findings };
};

export default handler;
