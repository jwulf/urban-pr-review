// Red/green regression for pr.persist-round's round recording + parking behaviour.
//
// The convergence loop routes both `addressed` (the agent pushed changes) and the new `waiting`
// (nothing to triage yet — round 1, awaiting the first review) statuses through gw-guard into
// persist-round. Both must be recorded in `rounds` under their own status and both must park the
// PR in `waiting_review` so the deterministic poller (app/service.ts) starts soliciting a review.
// A `waiting` round is what replaced the old failure mode where an agent with nothing to do
// re-requested the review destructively and escalated `blocked`.
import { assertEquals } from "jsr:@std/assert@1";
import handler from "../workers/persist-round/worker.ts";

function fakeApp() {
  const inserts: Record<string, unknown[]> = { rounds: [] };
  const updates: Record<string, unknown[]> = { pull_requests: [] };
  const app = {
    data: {
      table(name: string, _key: string) {
        return {
          // deno-lint-ignore require-await
          async insert(row: unknown) {
            (inserts[name] ??= []).push(row);
            return 1;
          },
          // deno-lint-ignore require-await
          async update(key: string, patch: unknown) {
            (updates[name] ??= []).push({ key, patch });
          },
        };
      },
    },
  };
  return { app, inserts, updates };
}

for (const status of ["addressed", "waiting"]) {
  Deno.test(`persist-round records a '${status}' round and parks the PR in waiting_review`, async () => {
    const { app, inserts, updates } = fakeApp();
    const job = { variables: { prKey: "o/r#1", round: 1, status, summary: `round was ${status}` } };
    // deno-lint-ignore no-explicit-any
    await handler(job as any, app as any);

    assertEquals(inserts.rounds.length, 1, "the round is recorded");
    // deno-lint-ignore no-explicit-any
    const round = inserts.rounds[0] as any;
    assertEquals(round.status, status, "the round carries the agent's status");
    assertEquals(round.round_no, 1);

    assertEquals(updates.pull_requests!.length, 1, "the PR is updated once");
    // deno-lint-ignore no-explicit-any
    const patch = (updates.pull_requests![0] as any).patch;
    assertEquals(patch.status, "waiting_review", "the PR parks in waiting_review for the poller");
    assertEquals(patch.current_round, 1);
  });
}

// When the agent omits `status` (e.g. a fallback), persist-round defaults it to `addressed`
// rather than writing a NULL status — the round history stays readable.
Deno.test("persist-round defaults a missing status to 'addressed'", async () => {
  const { app, inserts } = fakeApp();
  const job = { variables: { prKey: "o/r#1", round: 2 } };
  // deno-lint-ignore no-explicit-any
  await handler(job as any, app as any);
  // deno-lint-ignore no-explicit-any
  assertEquals((inserts.rounds[0] as any).status, "addressed");
});
