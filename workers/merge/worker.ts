// pr.merge — attempt to land the PR (SPEC §11). Returns `mergeStatus`:
//   • merged  — landed now (direct merge)            → process marks it merged
//   • queued  — added to the repo's merge queue       → process waits for `merge-landed`
//   • blocked — GitHub refused (conflict / failing gate / perms) → escalate to a human, who
//               resolves it and replies to retry (the process re-arms and re-polls).
// The actual gh/API call and its interpretation live in app/github.ts; this worker records the
// attempt in the `merges` audit table and shapes the escalation payload on a block.
import type { AppJobHandler } from "@nanobpm/urban";
import { mergePr } from "../../app/github.ts";
import { MERGE_ADMIN, MERGE_METHOD } from "../../app/service.ts";

interface In extends Record<string, unknown> {
  prKey: string;
  repo: string;
  prNumber: number;
}

interface Out extends Record<string, unknown> {
  mergeStatus: "merged" | "queued" | "blocked";
  status?: string;
  question?: string;
}

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const { prKey, repo, prNumber } = job.variables;
  const token = process.env.GITHUB_TOKEN ?? "";
  const now = new Date().toISOString();

  const res = await mergePr(repo, prNumber, token, { method: MERGE_METHOD, admin: MERGE_ADMIN });
  // No usable transport → treat as a block so a human is asked to configure/merge, rather than
  // silently completing the process without landing the PR.
  const outcome = res?.outcome ?? "blocked";
  const detail = res?.detail ?? "no GitHub transport available (configure gh or GITHUB_TOKEN)";

  await app.data.table("merges", "id").insert({
    pr_key: prKey,
    outcome,
    method: outcome === "queued" ? "queue" : MERGE_METHOD,
    detail,
    at: now,
  });

  if (outcome === "queued") {
    await app.data.table("pull_requests", "pr_key").update(prKey, {
      status: "queued",
      updated_at: now,
    });
    return { mergeStatus: "queued" };
  }
  if (outcome === "merged") {
    return { mergeStatus: "merged" };
  }
  // blocked → hand the escalation machinery a concrete question.
  return {
    mergeStatus: "blocked",
    status: "blocked",
    question:
      `Automated merge was blocked: ${detail}. ` +
      `Resolve it on GitHub (rebase / fix a required check / grant merge rights), then reply to retry.`,
  };
};

export default handler;
