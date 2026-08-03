// GET /app/status — list the PRs currently in flight (every tracked PR not converged/abandoned).
// A read-only projection over the app datasource so an operator or an external automation
// harness can see active work — and grab a `prKey` to cancel — without opening the DB or the UI.
import type { ActionHandler } from "@nanobpm/urban";
import { activePrs } from "../app/service.ts";

const handler: ActionHandler = async (_input, app) => {
  const prs = await activePrs(app.data);
  return { status: 200, body: { count: prs.length, prs } };
};

export default handler;
