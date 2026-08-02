// pr.persist-round — records an "addressed" round and parks the PR in `waiting_review` so the
// poller starts watching for the next review.
//
// Data access goes through the injected app datasource gateway (`app.data.table<T>`), the RAD
// `Table<T>` surface — `rounds.insert(...)` / `pull_requests.update(...)`, not hand-written SQL.
import type { AppJobHandler } from "@nanobpm/urban";

interface In {
  prKey: string;
  round: number;
  status?: string;
  summary?: string;
}

// The harness records the agent's full (byte-capped) stdout on the result envelope; keep it
// for audit so a human can see what the agent did this round.
const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
function transcriptOf(vars: Record<string, unknown>): string | null {
  const env = vars[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  return typeof env?.output === "string" ? env.output : null;
}

const handler: AppJobHandler = async (job, app) => {
  const { prKey, round, status = "addressed", summary = "" } = job.variables as unknown as In;
  const now = new Date().toISOString();

  await app.data.table("rounds", "id").insert({
    pr_key: prKey,
    round_no: round,
    status,
    summary,
    transcript: transcriptOf(job.variables),
    started_at: now,
    ended_at: now,
  });
  await app.data.table("pull_requests", "pr_key").update(prKey, {
    status: "waiting_review",
    current_round: round,
    waiting_since: now,
    updated_at: now,
  });

  return {};
};

export default handler;
