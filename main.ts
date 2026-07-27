// urban-pr-review — Urban App entrypoint.
//
// The `nano.app.json` manifest is the source of truth (models, sqlite datasource,
// app-hosted workers). This entrypoint:
//   1. deploys the BPMN + starts the app-hosted record workers,
//   2. serves the custom web UI + JSON API from `public/`,
//   3. runs the review-ready poller.
//
// Two client surfaces (see SPEC §"clients"):
//   • @nanobpm/nano-sdk  — the ENGINE client (createProcessInstance, publishMessage)
//   • @nanobpm/data      — the app's own sqlite datasource (pull_requests/rounds/escalations)
import { deployAllResources, startLlmWorkers, startWorkers } from "@lib/nano.ts";
import { createCamundaClient } from "@nanobpm/nano-sdk";
import { openDataSource } from "@nanobpm/data";

const PORT = Number(Deno.env.get("PORT") ?? 8090);
const POLL_MS = Number(Deno.env.get("NANO_PR_POLL_MS") ?? 60_000);
const MAX_ROUNDS = Number(Deno.env.get("NANO_PR_MAX_ROUNDS") ?? 10);
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("NANO_PR_WEBHOOK_SECRET") ?? "";
const PROCESS_ID = "convergence-loop";

const nano = createCamundaClient();
const db = await openDataSource();

// ── boot ───────────────────────────────────────────────────────────────────
await deployAllResources();
await startWorkers();
await startLlmWorkers();

// The prompt asset is read once at submit time and carried on the instance
// (SPEC §9), so a PR keeps the instructions it started with for its whole run.
const REVIEW_PROMPT = await Deno.readTextFile("prompts/review-round.md").catch(
  () => "",
);

// ── helpers ──────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Parse "owner/repo#123" or a canonical PR URL into its parts. */
function parsePr(input: string): { repo: string; number: number; url: string; prKey: string } | null {
  const s = input.trim();
  let m = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    const number = Number(m[3]);
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, prKey: `${repo}#${number}` };
  }
  m = s.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (m) {
    const repo = m[1];
    const number = Number(m[2]);
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, prKey: `${repo}#${number}` };
  }
  return null;
}

/** Register a PR row (if new) and start the convergence process. Idempotent on prKey. */
async function submitPr(repo: string, number: number, url: string, prKey: string) {
  const existing = await db.query("SELECT status FROM pull_requests WHERE pr_key = ?", [prKey]);
  if (existing.length && !["converged", "abandoned"].includes(String(existing[0].status))) {
    return { prKey, alreadyRunning: true };
  }
  const ts = now();
  await db.exec(
    `INSERT INTO pull_requests (pr_key, repo, number, url, status, current_round, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'converging', 1, ?, ?)
     ON CONFLICT(pr_key) DO UPDATE SET
       status='converging', current_round=1, url=excluded.url,
       waiting_since=NULL, last_review_id=NULL, outcome=NULL, converged_at=NULL, updated_at=excluded.updated_at`,
    [prKey, repo, number, url, ts, ts],
  );
  const res = await nano.createProcessInstance({
    processDefinitionId: PROCESS_ID,
    variables: { repo, prNumber: number, prUrl: url, prKey, round: 1, maxRounds: MAX_ROUNDS, prompt: REVIEW_PROMPT },
  } as unknown as Parameters<typeof nano.createProcessInstance>[0]);
  const processKey = (res as { processInstanceKey?: string | number }).processInstanceKey;
  if (processKey != null) {
    await db.exec("UPDATE pull_requests SET process_key = ? WHERE pr_key = ?", [String(processKey), prKey]);
  }
  return { prKey, processKey };
}

/** Answer an open escalation → record it and resume the process. */
async function answerEscalation(prKey: string, answer: string) {
  const open = await db.query(
    "SELECT id FROM escalations WHERE pr_key = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
    [prKey],
  );
  if (!open.length) return { ok: false, reason: "no open escalation" };
  const escalationId = Number(open[0].id);
  const ts = now();
  await db.exec(
    "UPDATE escalations SET answer = ?, status = 'answered', answered_at = ? WHERE id = ?",
    [answer, ts, escalationId],
  );
  await db.exec("UPDATE pull_requests SET status = 'converging', updated_at = ? WHERE pr_key = ?", [ts, prKey]);
  await nano.publishMessage({
    name: "escalation-answered",
    correlationKey: prKey,
    variables: { answer, escalationId },
  });
  return { ok: true, escalationId };
}

/** Aggregate PRs with their rounds + escalations for the UI. */
async function listPrs(scope: "active" | "history") {
  const cond = scope === "history"
    ? "status IN ('converged','abandoned')"
    : "status NOT IN ('converged','abandoned')";
  const prs = await db.query(`SELECT * FROM pull_requests WHERE ${cond} ORDER BY updated_at DESC`);
  const out = [];
  for (const pr of prs) {
    const prKey = String(pr.pr_key);
    const rounds = await db.query("SELECT * FROM rounds WHERE pr_key = ? ORDER BY round_no, id", [prKey]);
    const escalations = await db.query("SELECT * FROM escalations WHERE pr_key = ? ORDER BY id", [prKey]);
    out.push({ ...pr, rounds, escalations, openEscalation: escalations.find((e) => e.status === "open") ?? null });
  }
  return out;
}

// ── review-ready poller (SPEC §10) ────────────────────────────────────────────
async function pollOnce() {
  if (!GITHUB_TOKEN) return; // no token → poller idles (webhook/manual still work)
  const waiting = await db.query(
    "SELECT pr_key, repo, number, waiting_since, last_review_id FROM pull_requests WHERE status = 'waiting_review'",
  );
  for (const pr of waiting) {
    const repo = String(pr.repo);
    const number = Number(pr.number);
    const prKey = String(pr.pr_key);
    const lastId = Number(pr.last_review_id ?? 0);
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}/reviews?per_page=100`, {
        headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: "application/vnd.github+json" },
      });
      if (!r.ok) continue;
      const reviews = (await r.json()) as Array<{ id: number; state: string; submitted_at?: string }>;
      const fresh = reviews
        .filter((rv) => rv.id > lastId && rv.submitted_at && (!pr.waiting_since || rv.submitted_at >= String(pr.waiting_since)))
        .sort((a, b) => a.id - b.id)
        .pop();
      if (!fresh) continue;
      await db.exec(
        "UPDATE pull_requests SET last_review_id = ?, status = 'converging', updated_at = ? WHERE pr_key = ?",
        [fresh.id, now(), prKey],
      );
      await nano.publishMessage({
        name: "review-ready",
        correlationKey: prKey,
        variables: { reviewId: fresh.id, reviewState: fresh.state, submittedAt: fresh.submitted_at },
      });
      console.log(`[poller] review ${fresh.id} (${fresh.state}) → ${prKey}`);
    } catch (err) {
      console.error(`[poller] ${prKey}: ${err}`);
    }
  }
}
setInterval(() => void pollOnce(), POLL_MS);

// ── HTTP: web UI + JSON API ───────────────────────────────────────────────────
Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  const { pathname } = url;

  // API: list
  if (req.method === "GET" && pathname === "/api/prs") {
    const scope = url.searchParams.get("scope") === "history" ? "history" : "active";
    return json(await listPrs(scope));
  }

  // API: submit (form / UI)
  if (req.method === "POST" && pathname === "/api/prs") {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const raw = String((body.url ?? body.pr ?? body.repo ?? "") as string) +
      (body.number ? `#${body.number}` : "");
    const parsed = parsePr(raw);
    if (!parsed) return json({ error: "could not parse PR (use owner/repo#123 or a PR URL)" }, 400);
    return json(await submitPr(parsed.repo, parsed.number, parsed.url, parsed.prKey), 202);
  }

  // Webhook: submit (shared-secret auth via X-Hook-Secret)
  if (req.method === "POST" && pathname === "/hooks/submit") {
    if (WEBHOOK_SECRET && req.headers.get("x-hook-secret") !== WEBHOOK_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const parsed = parsePr(String((body.url ?? body.pr ?? "") as string));
    if (!parsed) return json({ error: "could not parse PR url" }, 400);
    return json(await submitPr(parsed.repo, parsed.number, parsed.url, parsed.prKey), 202);
  }

  // API: answer an escalation
  const answerMatch = pathname.match(/^\/api\/prs\/(.+)\/answer$/);
  if (req.method === "POST" && answerMatch) {
    const prKey = decodeURIComponent(answerMatch[1]);
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const answer = String((body.answer ?? "") as string).trim();
    if (!answer) return json({ error: "answer is required" }, 400);
    const r = await answerEscalation(prKey, answer);
    return json(r, r.ok ? 200 : 404);
  }

  // Static SPA
  const rel = pathname === "/" ? "/index.html" : pathname;
  try {
    const file = await Deno.readTextFile(`public${rel}`);
    const type = rel.endsWith(".html")
      ? "text/html"
      : rel.endsWith(".js")
      ? "text/javascript"
      : rel.endsWith(".css")
      ? "text/css"
      : "text/plain";
    return new Response(file, { headers: { "content-type": `${type}; charset=utf-8` } });
  } catch {
    return new Response("not found", { status: 404 });
  }
});

console.log(`urban-pr-review serving on :${PORT} (poll ${POLL_MS}ms, maxRounds ${MAX_ROUNDS})`);
