// urban-pr-review — Urban App entrypoint (ADR 0055).
//
// The whole app is declared in `nano.app.json` (models, sqlite datasource, app-hosted record
// workers, the schema-driven pages surface, and the action overrides) and materialized by the
// `@nanobpm/urban` runtime via `runFromEnv`:
//   • deploys the BPMN + hosts the `pr.*` record workers (workers/*/worker.ts),
//   • serves the schema-driven page runtime (ADR 0042) from `pages/home.page.json`,
//   • mounts the app-specific action overrides (actions/*.ts) that wrap the generic
//     start/cancel/message actions, plus the `/hooks/submit` webhook.
//
// The only thing that isn't declarative is the review-ready poller: it does arbitrary GitHub
// polling and then correlates a `review-ready` message. A cron trigger can only fire an engine
// start/message action, not this custom I/O glue, so it stays app-side here — driving the same
// engine client the runtime uses, over `app.data`.
//
// The reviewer agent (job type `senior:pr-review`) is deliberately NOT hosted here — it is an
// EXTERNAL worker. Point a coding-agent harness at that job type (the same one that services
// the code-first twin) so the automated review stays decoupled from the orchestration.
import { createNanoSdkEngineClient, runFromEnv, selectHost } from "@nanobpm/urban";
import { pollOnce } from "./app/service.ts";

const PORT = Number(Deno.env.get("PR_REVIEW_PORT") ?? 3000);
const POLL_MS = Number(Deno.env.get("NANO_PR_POLL_MS") ?? 60_000);
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";

const host = selectHost();

// One engine client, shared by the runtime (surfaces/actions/workers) and the poller. Honour
// the app's documented NANOBPMN_BASE_URL as well as the runtime's CAMUNDA_REST_ADDRESS.
const restAddress = Deno.env.get("CAMUNDA_REST_ADDRESS") ??
  `${(Deno.env.get("NANOBPMN_BASE_URL") ?? "http://localhost:8080").replace(/\/+$/, "")}/v2`;
const engine = await createNanoSdkEngineClient({
  restAddress,
  token: Deno.env.get("CAMUNDA_TOKEN"),
  transport: Deno.env.get("CAMUNDA_TRANSPORT") ?? "auto",
  log: host.log,
});

// Manage our own shutdown so the poller interval is cleared and the process exits (the runtime
// signal handler would only stop the HTTP server, leaving the interval keeping us alive).
const app = await runFromEnv({ engine, host, port: PORT, handleSignals: false });

const timer = app.data
  ? setInterval(() => void pollOnce(app.data!, engine, GITHUB_TOKEN), POLL_MS)
  : undefined;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(sig, () => {
      if (timer !== undefined) clearInterval(timer);
      app.stop().finally(() => Deno.exit(0));
    });
  } catch {
    // Signal listeners may be unavailable on some platforms (e.g. Windows).
  }
}

console.log(`urban-pr-review serving on :${PORT} (poll ${POLL_MS}ms, maxRounds ${Deno.env.get("NANO_PR_MAX_ROUNDS") ?? 10})`);
