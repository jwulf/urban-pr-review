// GET/POST /hooks/blackboard?token=<capabilityToken> — the epic coordination blackboard endpoint
// (Tier 1, issues #51 / #49 D4).
//
// This is a DIRECT side-channel for agents, distinct from the c8ctl-nano activation/completion
// channel. The per-plan capability token (query string) IS the credential: it scopes every read
// and write to exactly one plan, so no shared secret is needed — the agent curls the exact URL it
// was handed in its prompt. An unknown token is a 404 (never leaks which plans exist).
//
//   GET  → { planKey, entries: [ { id, author_task, kind, files, body, wave, created_at } ] }
//          optional ?since=<id> returns only entries with id > since (incremental poll).
//   POST → append one entry: { author_task?, kind?, files?, body, wave?, dedupe_key? }. Idempotent
//          on (plan, dedupe_key). Returns { id, inserted }.
import type { ActionHandler } from "@nanobpm/urban";
import { appendEntry, normalizeKind, planKeyForToken, readBlackboard } from "../app/blackboard.ts";

const handler: ActionHandler = async ({ req, body }, app) => {
  const token = (req.query.get("token") ?? req.headers.get("x-blackboard-token") ?? "").trim();
  if (!token) return { status: 400, body: { error: "missing blackboard token" } };
  const planKey = await planKeyForToken(app.data, token);
  if (!planKey) return { status: 404, body: { error: "unknown blackboard token" } };

  if (req.method === "GET") {
    const rawSince = req.query.get("since");
    const since = rawSince != null && /^\d+$/.test(rawSince) ? Number(rawSince) : undefined;
    const entries = await readBlackboard(app.data, planKey, { since });
    return { status: 200, body: { planKey, entries } };
  }

  if (req.method === "POST") {
    const b = (body ?? {}) as Record<string, unknown>;
    const text = typeof b.body === "string" ? b.body.trim() : "";
    if (!text) return { status: 400, body: { error: "'body' (the note text) is required" } };
    const files = Array.isArray(b.files) ? b.files.map(String) : [];
    const res = await appendEntry(app.data, planKey, {
      author_task: typeof b.author_task === "string" ? b.author_task : undefined,
      kind: normalizeKind(b.kind),
      files,
      body: text,
      wave: typeof b.wave === "number" ? b.wave : null,
      dedupe_key: typeof b.dedupe_key === "string" ? b.dedupe_key : undefined,
    });
    return { status: res.inserted ? 201 : 200, body: { id: Number(res.id), inserted: res.inserted } };
  }

  return { status: 405, body: { error: "method not allowed (use GET or POST)" } };
};

export default handler;
