// POST /app/actions/cancel — override the generic row-cancel action. Terminating the engine
// instance emits no completion event, so reconcile the app row (status='abandoned', clear the
// open escalation) here.
import type { ActionHandler } from "@nanobpm/urban";
import { cancelRun } from "../app/service.ts";

const handler: ActionHandler = async ({ body }, app) => {
  const key = (body as { processInstanceKey?: unknown })?.processInstanceKey;
  if (key == null || String(key) === "") {
    return { status: 400, body: { error: "processInstanceKey is required" } };
  }
  const r = await cancelRun(app.data, app.engine, String(key));
  return { status: r.ok ? 200 : 404, body: r };
};

export default handler;
