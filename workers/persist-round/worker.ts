// pr.persist-round — records an "addressed" round and parks the PR in
// `waiting_review` so the poller starts watching for the next review.
//
// Data access goes through the typed data object (`@nanobpm/domain`, the RAD
// "TTable") — `db.rounds.insert(...)` / `db.pull_requests.update(...)`, not
// hand-written SQL. Row shapes come from the generated `domain-rows.d.ts`.
import { defineWorker } from "@nanobpm/worker";
import { openDomain } from "@nanobpm/domain";

const db = await openDomain("app");

interface In {
  prKey: string;
  round: number;
  status?: string;
  summary?: string;
}

defineWorker({
  type: "pr.persist-round",
  async handle(job) {
    const { prKey, round, status = "addressed", summary = "" } = job.variables as unknown as In;
    const now = new Date().toISOString();

    await db.rounds.insert({
      pr_key: prKey, round_no: round, status, summary,
      started_at: now, ended_at: now,
    });
    await db.pull_requests.update(prKey, {
      status: "waiting_review", current_round: round,
      waiting_since: now, updated_at: now,
    });

    return {};
  },
});
