// POST /app/actions/cancel — override the generic row-cancel action. Terminating the engine
// instance emits no completion event, so reconcile the app row (status='abandoned', clear the
// open escalation) here. Accepts either `processInstanceKey` or the `prKey` the status endpoint
// reports, so a caller can cancel a run it discovered via GET /app/status.
import type { ActionHandler } from "@nanobpm/urban";
import { cancelRun } from "../app/service.ts";

const str = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
};

const handler: ActionHandler = async ({ body }, app) => {
  const b = (body ?? {}) as { processInstanceKey?: unknown; prKey?: unknown };
  const processInstanceKey = str(b.processInstanceKey);
  const prKey = str(b.prKey);
  if (!processInstanceKey && !prKey) {
    return { status: 400, body: { error: "processInstanceKey or prKey is required" } };
  }
  if (processInstanceKey && prKey) {
    return { status: 400, body: { error: "provide exactly one of processInstanceKey or prKey" } };
  }
  const r = await cancelRun(app.data, app.engine, { processInstanceKey, prKey });
  if (r.ok) return { status: 200, body: r };
  return { status: r.kind === "terminal" ? 409 : 404, body: r };
};

export default handler;
