// pr.merge — attempt to land the PR (SPEC §11). Returns `mergeStatus`:
//   • merged  — landed now (direct merge)            → process marks it merged
//   • queued  — added to the repo's merge queue       → process waits for `merge-landed`
//   • blocked — GitHub refused (conflict / failing gate / perms) → escalate to a human, who
//               resolves it and replies to retry (the process re-arms and re-polls).
// HOW it lands is governed by the target repo's published merge protocol (#43): a `mergify-queue`
// repo (e.g. Magikcraft/nano-bpm, auto-merge OFF) is landed by posting `@mergifyio queue` and
// waiting for the queue, NOT a direct `gh pr merge` — which that repo refuses. The actual gh/API
// calls live in app/github.ts; this worker records the attempt in the `merges` audit table and
// shapes the escalation payload on a block.
import type { AppJobHandler } from "@nanobpm/urban";
import { enqueueViaComment, mergePr } from "../../app/github.ts";
import { MERGE_ADMIN, MERGE_METHOD } from "../../app/service.ts";
import { loadMergeProtocol } from "../../app/mergeProtocol.ts";

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

  const protocol = await loadMergeProtocol(repo, token).catch(() => null);
  const method = protocol?.land.method ?? "gh-merge";

  let outcome: "merged" | "queued" | "blocked";
  let detail: string;
  let auditMethod: string;

  if (method === "mergify-queue") {
    // Land via the repo's on-demand queue: post the enqueue comment; the poller's queued→landed
    // watch (service.ts block 3) then advances the process when the queue merges it.
    const comment = protocol?.land.comment ?? "@mergifyio queue";
    const ok = await enqueueViaComment(repo, prNumber, token, comment);
    outcome = ok ? "queued" : "blocked";
    detail = ok ? `enqueued via "${comment}"` : `failed to post enqueue comment "${comment}"`;
    auditMethod = "queue-comment";
  } else if (method === "ui") {
    // The repo requires a human to click Merge; Merlin can't. Escalate rather than pretend.
    outcome = "blocked";
    detail = "repo merge protocol requires a manual UI merge (land.method=ui)";
    auditMethod = "ui";
  } else {
    const admin = method === "admin" || MERGE_ADMIN;
    const res = await mergePr(repo, prNumber, token, { method: MERGE_METHOD, admin });
    // No usable transport → treat as a block so a human is asked to configure/merge, rather than
    // silently completing the process without landing the PR.
    outcome = res?.outcome ?? "blocked";
    detail = res?.detail ?? "no GitHub transport available (configure gh or GITHUB_TOKEN)";
    auditMethod = outcome === "queued" ? "queue" : MERGE_METHOD;
  }

  await app.data.table("merges", "id").insert({
    pr_key: prKey,
    outcome,
    method: auditMethod,
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
  const docHint = protocol?.doc ? ` See the repo's merge protocol (${protocol.doc}).` : "";
  return {
    mergeStatus: "blocked",
    status: "blocked",
    question:
      `Automated merge was blocked: ${detail}. ` +
      `Resolve it on GitHub (rebase / fix a required check / grant merge rights), then reply to retry.${docHint}`,
  };
};

export default handler;

