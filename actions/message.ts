// POST /app/actions/message — override the generic publishMessage action. For the
// `escalation-answered` message we run the app's answer flow (record the answer, clear the
// open escalation, then publish); any other message falls back to a plain publishMessage
// (this override shadows the generic route entirely, so the fallback preserves it).
import type { ActionHandler } from "@nanobpm/urban";
import { answerEscalation } from "../app/service.ts";

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

  await app.engine.publishMessage({
    name,
    correlationKey: b.correlationKey != null ? String(b.correlationKey) : undefined,
    variables: b.variables,
  });
  return { status: 200, body: { ok: true } };
};

export default handler;
