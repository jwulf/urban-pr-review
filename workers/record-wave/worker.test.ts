// Red/green regression for retrying a wave when `select-wave` deliberately left pending work
// behind a non-fatal wait (D7 / issue #63). Advancing past that wave would make `record-results`
// finish the plan with a still-pending task.
import { assertEquals } from "jsr:@std/assert@1";
import handler from "./worker.ts";
import type { PlanTaskStatus } from "../../app/plan.ts";

interface Row {
  id: number;
  plan_key: string;
  task_id: string;
  status: PlanTaskStatus;
  wave?: number | null;
}

function fakeApp(rows: Row[]) {
  const planUpdates: Record<string, unknown>[] = [];
  return {
    app: {
      data: {
        table(name: string, key: string) {
          const store = name === "plan_tasks" ? rows : [];
          return {
            // deno-lint-ignore no-explicit-any
            find: (q: any) =>
              Promise.resolve(
                store.filter((r) =>
                  Object.entries(q).every(([f, v]) =>
                    ((r as unknown) as Record<string, unknown>)[f] === v
                  )
                ),
              ),
            // deno-lint-ignore no-explicit-any
            update: (k: any, patch: any) => {
              if (name === "plans") {
                planUpdates.push({ key: k, patch });
                return Promise.resolve(undefined);
              }
              const row = store.find((r) =>
                ((r as unknown) as Record<string, unknown>)[key] === k
              );
              if (row) Object.assign(row, patch);
              return Promise.resolve(row);
            },
          };
        },
      },
      log: () => undefined,
      engine: {},
      // deno-lint-ignore no-explicit-any
    } as any,
    planUpdates,
  };
}

Deno.test("record-wave retries the same wave when a task is still pending", async () => {
  const rows: Row[] = [{
    id: 2,
    plan_key: "owner/repo#63",
    task_id: "b",
    status: "pending",
    wave: 1,
  }];
  const { app, planUpdates } = fakeApp(rows);

  const out = await handler(
    // deno-lint-ignore no-explicit-any
    {
      variables: {
        planKey: "owner/repo#63",
        currentWave: 1,
        waveCount: 2,
        waveTasks: [],
        waveResults: [],
      },
    } as any,
    app,
  ) as Record<string, unknown>;

  assertEquals(out, {
    currentWave: 1,
    hasMoreWaves: true,
    waveOpenHeads: [],
    runTrialMerge: false,
    trialMergeWave: 1,
    trialMergeSkipReason: "fewer-than-two-open-heads",
  });
  assertEquals((planUpdates[0].patch as Record<string, unknown>).gate_wave, 1);
});
