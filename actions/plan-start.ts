// POST /app/actions/start/plan-fanout — override the generic "start process" action for the
// planning fan-out. We parse the issue reference and register/refresh the plan aggregate
// (idempotent on planKey) before starting the process.
import type { ActionHandler } from "@nanobpm/urban";
import { parseIssue, startPlan } from "../app/plan.ts";

const handler: ActionHandler = async ({ body }, app) => {
  const vars = ((body as { variables?: Record<string, unknown> })?.variables ?? {}) as Record<string, unknown>;
  const raw = String((vars.issue ?? vars.url ?? "") as string).trim();
  const parsed = parseIssue(raw);
  if (!parsed) {
    return { status: 400, body: { error: "could not parse issue (use owner/repo#123 or an issue URL)" } };
  }
  return { status: 202, body: await startPlan(app.data, app.engine, parsed) };
};

export default handler;
