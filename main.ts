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
//   • @nanobpm/domain    — the app's own sqlite datasource as a typed data object
//                          (db.pull_requests/db.rounds/db.escalations, db.raw escape hatch)
import { deployAllResources, startLlmWorkers, startWorkers } from "@lib/nano.ts";
import { createCamundaClient } from "@nanobpm/nano-sdk";
import { openDomain } from "@nanobpm/domain";

const PORT = Number(Deno.env.get("PR_REVIEW_PORT") ?? 3000);
const POLL_MS = Number(Deno.env.get("NANO_PR_POLL_MS") ?? 60_000);
const MAX_ROUNDS = Number(Deno.env.get("NANO_PR_MAX_ROUNDS") ?? 10);
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("NANO_PR_WEBHOOK_SECRET") ?? "";
const PROCESS_ID = "convergence-loop";

const nano = createCamundaClient();
const db = await openDomain("app");

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
  const existing = await db.pull_requests.get(prKey);
  if (existing && !["converged", "abandoned"].includes(existing.status)) {
    return { prKey, alreadyRunning: true };
  }
  const ts = now();
  if (existing) {
    // Re-open a previously converged/abandoned PR for a fresh convergence run.
    await db.pull_requests.update(prKey, {
      status: "converging", current_round: 1, url,
      waiting_since: null, last_review_id: null, outcome: null, converged_at: null,
      updated_at: ts,
    });
  } else {
    await db.pull_requests.insert({
      pr_key: prKey, repo, number, url, status: "converging", current_round: 1,
      created_at: ts, updated_at: ts,
    });
  }
  const res = await nano.createProcessInstance({
    processDefinitionId: PROCESS_ID,
    variables: { repo, prNumber: number, prUrl: url, prKey, round: 1, maxRounds: MAX_ROUNDS, prompt: REVIEW_PROMPT },
  } as unknown as Parameters<typeof nano.createProcessInstance>[0]);
  const processKey = (res as { processInstanceKey?: string | number }).processInstanceKey;
  if (processKey != null) {
    await db.pull_requests.update(prKey, { process_key: String(processKey) });
  }
  return { prKey, processKey };
}

/** Answer an open escalation → record it and resume the process. */
async function answerEscalation(prKey: string, answer: string) {
  const open = (await db.escalations.find({ pr_key: prKey, status: "open" }))
    .sort((a, b) => b.id - a.id)[0];
  if (!open) return { ok: false, reason: "no open escalation" };
  const escalationId = open.id;
  const ts = now();
  await db.escalations.update(escalationId, { answer, status: "answered", answered_at: ts });
  await db.pull_requests.update(prKey, { status: "converging", updated_at: ts });
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
  // A set-valued, ordered query the record gateway doesn't express → the
  // sanctioned `db.raw` escape hatch (typed record ops are used everywhere else).
  const prs = await db.raw.query(`SELECT * FROM pull_requests WHERE ${cond} ORDER BY updated_at DESC`);
  const out = [];
  for (const pr of prs) {
    const prKey = String(pr.pr_key);
    const rounds = (await db.rounds.find({ pr_key: prKey }))
      .sort((a, b) => a.round_no - b.round_no || a.id - b.id)
      // Keep the polled list light: expose whether a round has captured output,
      // but stream the (potentially ~1 MB) transcript itself lazily on expand via
      // GET /api/prs/rounds/:id/output.
      .map(({ transcript, ...r }) => ({ ...r, has_output: transcript != null && String(transcript).trim() !== "" }));
    const escalations = (await db.escalations.find({ pr_key: prKey }))
      .sort((a, b) => a.id - b.id);
    out.push({ ...pr, rounds, escalations, openEscalation: escalations.find((e) => e.status === "open") ?? null });
  }
  return out;
}

// ── review-ready poller (SPEC §10) ────────────────────────────────────────────
async function pollOnce() {
  if (!GITHUB_TOKEN) return; // no token → poller idles (webhook/manual still work)
  const waiting = await db.pull_requests.find({ status: "waiting_review" });
  for (const pr of waiting) {
    const repo = pr.repo;
    const number = pr.number;
    const prKey = pr.pr_key;
    const lastId = pr.last_review_id ?? 0;
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}/reviews?per_page=100`, {
        headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: "application/vnd.github+json" },
      });
      if (!r.ok) continue;
      const reviews = (await r.json()) as Array<{ id: number; state: string; submitted_at?: string }>;
      const fresh = reviews
        .filter((rv) => rv.id > lastId && rv.submitted_at && (!pr.waiting_since || rv.submitted_at >= pr.waiting_since))
        .sort((a, b) => a.id - b.id)
        .pop();
      if (!fresh) continue;
      await db.pull_requests.update(prKey, {
        last_review_id: fresh.id, status: "converging", updated_at: now(),
      });
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

  // API: a single round's captured agent output (lazy-loaded when a round is
  // expanded in the UI, so the polled list stays small).
  const outputMatch = pathname.match(/^\/api\/prs\/rounds\/(\d+)\/output$/);
  if (req.method === "GET" && outputMatch) {
    const id = Number(outputMatch[1]);
    const [round] = await db.rounds.find({ id });
    if (!round) return json({ error: "round not found" }, 404);
    return json({ id, round_no: round.round_no, transcript: round.transcript ?? "" });
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
