// urban-pr-review — Urban App entrypoint.
//
// The `nano.app.json` manifest is the source of truth (models, sqlite datasource,
// app-hosted workers). This entrypoint:
//   1. deploys the BPMN + starts the app-hosted record workers,
//   2. serves the schema-driven page runtime (ADR 0042) from `pages/home.page.json`,
//      intercepting only the three app-specific actions (start/cancel/answer),
//   3. runs the review-ready poller.
//
// Three client surfaces (see SPEC §"clients"):
//   • @nanobpm/nano-sdk  — the ENGINE client (createProcessInstance, publishMessage)
//   • @nanobpm/domain    — the app's own sqlite datasource as a typed data object
//                          (db.pull_requests/db.rounds/db.escalations, db.raw escape hatch)
//   • @nanobpm/app       — the generic page runtime that renders `pages/*.page.json`
import { deployAllResources, startLlmWorkers, startWorkers } from "@lib/nano.ts";
import { createCamundaClient } from "@nanobpm/nano-sdk";
import { openDomain } from "@nanobpm/domain";
import { createPagesHandler } from "@nanobpm/app";

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
  await db.pull_requests.update(prKey, {
    status: "converging", updated_at: ts,
    open_escalation_id: null, open_escalation_question: null,
  });
  await nano.publishMessage({
    name: "escalation-answered",
    correlationKey: prKey,
    variables: { answer, escalationId },
  });
  return { ok: true, escalationId };
}

/** Cancel a PR's running convergence instance and mark it abandoned. Terminating
 * the engine instance emits no completion event (no worker runs), so the app-tier
 * flips the PR's status here — the same place ADR 0040 puts app-owned rest state. */
async function cancelRun(processInstanceKey: string) {
  const [pr] = await db.pull_requests.find({ process_key: processInstanceKey });
  try {
    await nano.cancelProcessInstance(
      { processInstanceKey } as unknown as Parameters<typeof nano.cancelProcessInstance>[0],
    );
  } catch (err) {
    // The instance may already be gone (converged/cancelled) — still reconcile
    // the app row so a stale "converging" PR can't linger in the UI.
    console.warn(`[cancel] engine cancel for ${processInstanceKey}: ${err}`);
  }
  if (pr) {
    await db.pull_requests.update(String(pr.pr_key), {
      status: "abandoned", updated_at: now(),
      open_escalation_id: null, open_escalation_question: null,
    });
    return { ok: true, prKey: pr.pr_key };
  }
  return { ok: false, reason: "no PR for that instance" };
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

// ── HTTP: schema-driven page runtime (ADR 0042) + app-specific action overrides ──
// The screen is authored declaratively in `pages/home.page.json` and served by the
// generic Urban page runtime — no hand-written SPA or list/detail API. Only the three
// actions that carry *app-specific* business logic (creating the PR aggregate on
// start, reconciling app state on cancel, running the escalation-answer flow) are
// intercepted here; the runtime handles rendering, data, filtering and the rest.
const pagesHandler = createPagesHandler({
  db: db.raw,
  nano: {
    createProcessInstance: (input) =>
      nano.createProcessInstance(
        input as unknown as Parameters<typeof nano.createProcessInstance>[0],
      ) as Promise<{ processInstanceKey?: string | number }>,
    cancelProcessInstance: (input) =>
      nano.cancelProcessInstance(
        { processInstanceKey: String(input.processInstanceKey) } as unknown as Parameters<
          typeof nano.cancelProcessInstance
        >[0],
      ),
    publishMessage: (input) => nano.publishMessage(input),
  },
  pagesDir: "pages",
  homePage: "home",
  sourceName: "app",
});

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  const { pathname } = url;

  // Override: start the convergence loop for a PR. The generic runtime would just
  // createProcessInstance; we first parse the PR reference and create the aggregate.
  if (req.method === "POST" && pathname === "/app/actions/start/convergence-loop") {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const vars = (body.variables ?? {}) as Record<string, unknown>;
    const raw = String((vars.pr ?? vars.url ?? "") as string).trim();
    const parsed = parsePr(raw);
    if (!parsed) return json({ error: "could not parse PR (use owner/repo#123 or a PR URL)" }, 400);
    return json(await submitPr(parsed.repo, parsed.number, parsed.url, parsed.prKey), 202);
  }

  // Override: cancel a run. Terminating the instance emits no completion event, so
  // reconcile the app row (status='abandoned', clear open escalation) here.
  if (req.method === "POST" && pathname === "/app/actions/cancel") {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const key = body.processInstanceKey;
    if (key == null || String(key) === "") return json({ error: "processInstanceKey is required" }, 400);
    const r = await cancelRun(String(key));
    return json(r, r.ok ? 200 : 404);
  }

  // Override: answer an escalation (message escalation-answered). Runs the app's
  // answer flow (record the answer, clear the open escalation) instead of a bare
  // publishMessage — the message is published inside answerEscalation.
  if (req.method === "POST" && pathname === "/app/actions/message") {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    if (String(body.name ?? "") === "escalation-answered") {
      const prKey = String(body.correlationKey ?? "");
      const vars = (body.variables ?? {}) as Record<string, unknown>;
      const answer = String((vars.answer ?? "") as string).trim();
      if (!prKey) return json({ error: "correlationKey is required" }, 400);
      if (!answer) return json({ error: "answer is required" }, 400);
      const r = await answerEscalation(prKey, answer);
      return json(r, r.ok ? 200 : 404);
    }
    // Fall through to the generic runtime for any other message.
  }

  // Webhook: submit (shared-secret auth via X-Hook-Secret). Not part of the page UI.
  if (req.method === "POST" && pathname === "/hooks/submit") {
    if (WEBHOOK_SECRET && req.headers.get("x-hook-secret") !== WEBHOOK_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const parsed = parsePr(String((body.url ?? body.pr ?? "") as string));
    if (!parsed) return json({ error: "could not parse PR url" }, 400);
    return json(await submitPr(parsed.repo, parsed.number, parsed.url, parsed.prKey), 202);
  }

  // Everything else — the screen, its data, filtering, and the non-overridden
  // actions — is served by the generic page runtime.
  return pagesHandler(req);
});

console.log(`urban-pr-review serving on :${PORT} (poll ${POLL_MS}ms, maxRounds ${MAX_ROUNDS})`);
