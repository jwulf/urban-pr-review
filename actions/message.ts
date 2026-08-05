// POST /app/actions/message — override the generic publishMessage action. For the
// `escalation-answered` message we run the review answer flow, and for
// `feature-escalation-answered` the implementation-phase (per-task) answer flow
// (issue #25): record the answer, resume the parked token, then re-surface the
// next open escalation. Any other message falls back to a plain publishMessage
// (this override shadows the generic route entirely, so the fallback preserves it).
import type { ActionHandler } from "@nanobpm/urban";
import { answerEscalation } from "../app/service.ts";
import { answerTaskEscalation, FEATURE_ESCALATION_MESSAGE } from "../app/plan.ts";

const handler: ActionHandler = async ({ body }, app) => {
  const b = (body ?? {}) as {
    name?: unknown;
    correlationKey?: unknown;
    variables?: Record<string, unknown>;
  };
  const name = String(b.name ?? "");
  if (!name) return { status: 400, body: { error: "name is required" } };

  if (name === "escalation-answered") {
    const prKey = String(b.correlationKey ?? "");
    const answer = String((b.variables?.answer ?? "") as string).trim();
    if (!prKey) return { status: 400, body: { error: "correlationKey is required" } };
    if (!answer) return { status: 400, body: { error: "answer is required" } };
    const r = await answerEscalation(app.data, app.engine, prKey, answer);
    return { status: r.ok ? 200 : 404, body: r };
  }

  if (name === FEATURE_ESCALATION_MESSAGE) {
    // Implementation-phase task escalation (issue #25): correlationKey is the
    // task's `<plan_key>:<task_id>`; record the answer, resume the parked child,
    // and re-surface the next open escalation.
    const corrKey = String(b.correlationKey ?? "");
    const answer = String((b.variables?.answer ?? "") as string).trim();
    if (!corrKey) return { status: 400, body: { error: "correlationKey is required" } };
    if (!answer) return { status: 400, body: { error: "answer is required" } };
    const r = await answerTaskEscalation(app.data, app.engine, corrKey, answer);
    return { status: r.ok ? 200 : 404, body: r };
  }

  await app.engine.publishMessage({
    name,
    correlationKey: b.correlationKey != null ? String(b.correlationKey) : undefined,
    variables: b.variables,
  });
  return { status: 200, body: { ok: true } };
};

export default handler;
