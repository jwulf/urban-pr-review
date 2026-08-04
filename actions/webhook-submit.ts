// POST /hooks/submit — submit a PR out-of-band (shared-secret auth via X-Hook-Secret). Not
// part of the page UI; lets an external system (a GitHub webhook relay, a CI job) kick off a
// convergence run. Same idempotent submit path as the page's "Start review" action.
import type { ActionHandler } from "@nanobpm/urban";
import { parsePr, submitPr } from "../app/service.ts";

const WEBHOOK_SECRET = process.env.NANO_PR_WEBHOOK_SECRET ?? "";

const handler: ActionHandler = async ({ req, body }, app) => {
  if (WEBHOOK_SECRET && req.headers.get("x-hook-secret") !== WEBHOOK_SECRET) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const b = (body ?? {}) as { url?: unknown; pr?: unknown; dependsOn?: unknown };
  const parsed = parsePr(String((b.url ?? b.pr ?? "") as string));
  if (!parsed) return { status: 400, body: { error: "could not parse PR url" } };
  const dependsOn = Array.isArray(b.dependsOn) ? b.dependsOn.map((d) => String(d)) : [];
  return { status: 202, body: await submitPr(app.data, app.engine, parsed, dependsOn) };
};

export default handler;
