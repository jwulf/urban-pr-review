// Red/green regression for re-submit clearing stale open escalations (Magikcraft/nano-bpm
// #597/#599). When a cancelled/converged PR is re-submitted, `submitPr` re-opens it for a fresh
// convergence run. Any escalation left `open` by the prior run — plus the denormalised
// `open_escalation_*` pointer on the PR row — must be cleared, or the answer form resurfaces a
// dead "(no question provided)" question on the re-opened PR (the same stale-row class the plan
// loop already guards in `startPlan`). Drives `submitPr` against an in-memory data layer with the
// GitHub transport forced off so it is hermetic.
import { assertEquals } from "jsr:@std/assert@1";
import { submitPr } from "./service.ts";

// deno-lint-ignore no-explicit-any
function memTable(rows: any[], key: string) {
  return {
    // deno-lint-ignore no-explicit-any
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    // deno-lint-ignore no-explicit-any
    find: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    // deno-lint-ignore no-explicit-any
    insert: (r: any) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    // deno-lint-ignore no-explicit-any
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r);
    },
    // deno-lint-ignore no-explicit-any
    delete: (k: any) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] === k) rows.splice(i, 1);
      return Promise.resolve();
    },
  };
}

function withGithubOff(run: () => Promise<void>): Promise<void> {
  const prevMode = Deno.env.get("NANO_PR_GITHUB_TRANSPORT");
  const prevTok = Deno.env.get("GITHUB_TOKEN");
  Deno.env.set("NANO_PR_GITHUB_TRANSPORT", "token"); // no token below -> fetchPrMeta returns null
  Deno.env.delete("GITHUB_TOKEN");
  return run().finally(() => {
    if (prevMode !== undefined) Deno.env.set("NANO_PR_GITHUB_TRANSPORT", prevMode);
    else Deno.env.delete("NANO_PR_GITHUB_TRANSPORT");
    if (prevTok !== undefined) Deno.env.set("GITHUB_TOKEN", prevTok);
  });
}

Deno.test("re-submit of a cancelled PR clears stale open escalations + the denormalised pointer", async () => {
  await withGithubOff(async () => {
    const PR_KEY = "owner/repo#42";
    const stores: Record<string, { rows: unknown[]; key: string }> = {
      pull_requests: {
        rows: [{
          pr_key: PR_KEY,
          repo: "owner/repo",
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          title: "old title",
          status: "abandoned", // terminal -> re-open path
          current_round: 3,
          open_escalation_id: 5,
          open_escalation_question: "(no question provided)",
        }],
        key: "pr_key",
      },
      escalations: {
        rows: [{ id: 5, pr_key: PR_KEY, round_no: 3, kind: "question", question: "(no question provided)", status: "open" }],
        key: "id",
      },
      pr_dependencies: { rows: [], key: "pr_key" },
    };
    const data = {
      table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
      // deno-lint-ignore no-explicit-any
    } as any;
    const engine = {
      createInstance: () => Promise.resolve({ processInstanceKey: "PI-9" }),
      // deno-lint-ignore no-explicit-any
    } as any;

    await submitPr(data, engine, {
      repo: "owner/repo",
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      prKey: PR_KEY,
    });

    // The prior run's open escalation is retired (not left "open" to resurface a dead form) …
    const esc = stores.escalations.rows[0] as Record<string, unknown>;
    assertEquals(esc.status, "stale");
    // … and the PR row is re-opened with the denormalised escalation pointer cleared.
    const pr = stores.pull_requests.rows[0] as Record<string, unknown>;
    assertEquals(pr.status, "converging");
    assertEquals(pr.current_round, 1);
    assertEquals(pr.open_escalation_id, null);
    assertEquals(pr.open_escalation_question, null);
    assertEquals(pr.process_key, "PI-9");
  });
});
