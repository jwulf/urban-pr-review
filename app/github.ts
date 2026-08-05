// GitHub review fetch for the review-ready poller (SPEC §10).
//
// Two transports, selected by `NANO_PR_GITHUB_TRANSPORT` (auto | gh | token):
//   • gh    — shell out to the host `gh` CLI. It uses the user's own GitHub login, so the
//             poller reaches every repository the user can reach — including private repos
//             that no PAT is (or can be) issued for. This is the default on a workstation.
//   • token — HTTP `fetch` to api.github.com with `GITHUB_TOKEN`. Used in headless/CI where
//             no interactive `gh` login exists.
//   • auto  — prefer `gh` when the binary is present; otherwise fall back to `token`.
//
// The poller is app-side host glue (main.ts), so host-specific subprocess I/O is allowed here.
// Cross-runtime: runs under Node (`node:child_process`) and Deno (`Deno.Command`).

/** A GitHub pull-request review, narrowed to the fields the poller needs. */
export interface GhReview {
  id: number;
  state: string;
  submitted_at?: string;
}

export type GithubTransport = "gh" | "token" | "auto";

/** Resolve the configured transport, defaulting to `auto`. */
export function githubTransport(): GithubTransport {
  const t = (process.env.NANO_PR_GITHUB_TRANSPORT ?? "auto").trim().toLowerCase();
  return t === "gh" || t === "token" ? t : "auto";
}

interface DenoCommandCtor {
  new (
    command: string,
    options: { args: string[]; stdout: "piped"; stderr: "piped" },
  ): { output(): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }> };
}

/** Run the host `gh` CLI with the given args (no shell — args are passed as a vector, so a
 * `repo`/`number` from the datastore cannot inject a command). Resolves stdout, rejects on a
 * non-zero exit with stderr as the message. */
async function runGh(args: string[]): Promise<string> {
  const g = globalThis as { Deno?: { Command?: DenoCommandCtor } };
  if (g.Deno?.Command) {
    const { code, stdout, stderr } = await new g.Deno.Command("gh", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (code !== 0) {
      throw new Error(new TextDecoder().decode(stderr).trim() || `gh exited ${code}`);
    }
    return new TextDecoder().decode(stdout);
  }
  const { execFile } = await import("node:child_process");
  return await new Promise<string>((resolve, reject) => {
    execFile(
      "gh",
      args,
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || "").trim() || err.message));
        else resolve(String(stdout));
      },
    );
  });
}

let ghAvailable: Promise<boolean> | undefined;
/** Whether the host `gh` CLI is present (memoized — probed at most once per process). */
function isGhAvailable(): Promise<boolean> {
  return (ghAvailable ??= runGh(["--version"]).then(() => true, () => false));
}

/** Fetch the reviews for one PR via the configured transport. Throws on transport failure so
 * the caller can log-and-continue; returns `null` when no transport is usable (idle). */
export async function fetchPrReviews(
  repo: string,
  number: number | string,
  token: string,
): Promise<GhReview[] | null> {
  const mode = githubTransport();
  const useGh = mode === "gh" || (mode === "auto" && (await isGhAvailable()));
  const path = `repos/${repo}/pulls/${number}/reviews?per_page=100`;
  if (useGh) {
    const out = await runGh(["api", path, "-H", "Accept: application/vnd.github+json"]);
    return JSON.parse(out) as GhReview[];
  }
  if (!token) return null; // token mode with no token → poller idles
  const r = await fetch(`https://api.github.com/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
  return (await r.json()) as GhReview[];
}

// ── Merge stage (SPEC §11) ──────────────────────────────────────────────────
// The same two-transport model (gh | token) backs the merge stage: read a PR's merge state to
// decide when it is landable, and perform the merge (directly or via the repo's merge queue).

/** Whether to use the `gh` CLI for this pass, honouring `NANO_PR_GITHUB_TRANSPORT`. */
async function useGh(): Promise<boolean> {
  const mode = githubTransport();
  return mode === "gh" || (mode === "auto" && (await isGhAvailable()));
}

/** PR metadata we read once at submit: the title (to label the row) and the body (to scan for a
 * `Depends-on:` line). `null` when no transport is usable. */
export interface PrMeta {
  title: string | null;
  body: string;
}

export async function fetchPrMeta(
  repo: string,
  number: number | string,
  token: string,
): Promise<PrMeta | null> {
  if (await useGh()) {
    const out = await runGh(["pr", "view", String(number), "--repo", repo, "--json", "title,body"]);
    const j = JSON.parse(out) as { title?: string; body?: string };
    return { title: j.title ?? null, body: j.body ?? "" };
  }
  if (!token) return null;
  const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
  const j = (await r.json()) as { title?: string; body?: string };
  return { title: j.title ?? null, body: j.body ?? "" };
}

/** A PR's merge state, narrowed to what the merge poller needs to classify landability.
 * `mergeStateStatus` uses GitHub's vocabulary (CLEAN | BLOCKED | BEHIND | DIRTY | UNSTABLE |
 * DRAFT | HAS_HOOKS | UNKNOWN). `failingChecks` is `-1` when the transport can't enumerate
 * checks (token mode) so the classifier stays conservative. `failingCheckNames` lists those
 * failing gates (empty in token mode) so the CI-fix agent knows what to make green. */
export interface PrState {
  merged: boolean;
  mergeStateStatus: string;
  failingChecks: number;
  failingCheckNames: string[];
}

/** Map GitHub's REST `mergeable_state` (lower-case) onto the GraphQL `mergeStateStatus`
 * vocabulary the classifier speaks, so both transports feed one code path. */
function normalizeMergeState(s: string): string {
  return (s || "unknown").toUpperCase();
}

interface RollupEntry {
  status?: string;
  conclusion?: string;
  state?: string;
  name?: string;
  context?: string;
  workflowName?: string;
}
/** Names of the checks whose result is a hard failure (as opposed to pending/success). Covers
 * both the CheckRun shape (`conclusion` + `name`/`workflowName`) and the legacy StatusContext
 * shape (`state` + `context`). The names are what the CI-fix agent is handed so it knows which
 * gates to make green; `failingChecks` (the count) is derived from this list. */
function failingCheckNames(rollup: RollupEntry[]): string[] {
  const bad = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
  const names: string[] = [];
  for (const c of rollup) {
    const v = (c.conclusion || c.state || "").toUpperCase();
    if (bad.has(v)) names.push(c.name || c.context || c.workflowName || "check");
  }
  return names;
}

export async function fetchPrState(
  repo: string,
  number: number | string,
  token: string,
): Promise<PrState | null> {
  if (await useGh()) {
    const out = await runGh([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "state,mergedAt,mergeStateStatus,statusCheckRollup",
    ]);
    const j = JSON.parse(out) as {
      state?: string;
      mergedAt?: string | null;
      mergeStateStatus?: string;
      statusCheckRollup?: RollupEntry[];
    };
    const rollup = j.statusCheckRollup ?? [];
    const names = failingCheckNames(rollup);
    return {
      merged: j.state === "MERGED" || !!j.mergedAt,
      mergeStateStatus: (j.mergeStateStatus || "UNKNOWN").toUpperCase(),
      failingChecks: names.length,
      failingCheckNames: names,
    };
  }
  if (!token) return null;
  const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`github ${r.status} ${r.statusText}`.trim());
  const j = (await r.json()) as { merged?: boolean; merged_at?: string | null; mergeable_state?: string };
  return {
    // The single-PR GET returns a `merged` boolean (unlike the list endpoint); we also honour
    // `merged_at` so this mirrors the gh branch's `state === "MERGED" || mergedAt` rule.
    merged: !!j.merged || !!j.merged_at,
    mergeStateStatus: normalizeMergeState(j.mergeable_state ?? "unknown"),
    failingChecks: -1, // REST here doesn't enumerate checks → classifier treats BLOCKED as "wait"
    failingCheckNames: [], // …and the CI-fix agent gets no per-check list in token mode
  };
}

/** A settled landability verdict, or `waiting` when GitHub hasn't determined it yet (or is
 * still running checks / awaiting review). The poller only advances the process on a settled
 * verdict; `waiting` means re-poll later. */
export type Mergeability = "ready" | "waiting" | "conflict" | "blocked";

export function classifyMergeability(s: PrState): Mergeability {
  switch (s.mergeStateStatus) {
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE": // only non-required checks failing — still mergeable
    case "BEHIND": // out of date; a queue rebases, a direct merge is still allowed
      return "ready";
    case "DIRTY":
      return "conflict";
    case "BLOCKED":
      // A required check failed -> a human must act. Pending checks / awaiting review -> wait.
      // When we can't enumerate checks (failingChecks < 0, token mode) stay conservative: wait.
      return s.failingChecks > 0 ? "blocked" : "waiting";
    case "DRAFT":
    default: // UNKNOWN / "" — GitHub is still computing mergeability
      return "waiting";
  }
}

export type MergeMethod = "squash" | "merge" | "rebase";
export interface MergeOptions {
  method: MergeMethod;
  admin: boolean;
}
export interface MergeResult {
  outcome: "merged" | "queued" | "blocked";
  detail: string;
}

/** Attempt to land the PR. Returns `merged` (landed now), `queued` (added to the repo's merge
 * queue — the poller then watches for it to land), or `blocked` (GitHub refused — a human must
 * resolve it, then reply to retry). `null` when no transport is usable. Never throws for a
 * refused merge; only a genuine transport failure propagates. */
export async function mergePr(
  repo: string,
  number: number | string,
  token: string,
  opts: MergeOptions,
): Promise<MergeResult | null> {
  const methodFlag = `--${opts.method}`;
  if (await useGh()) {
    const args = ["pr", "merge", String(number), "--repo", repo, methodFlag];
    if (opts.admin) args.push("--admin");
    try {
      const out = await runGh(args);
      // gh prints "… will be added to the merge queue" when the branch requires one.
      if (/merge queue/i.test(out)) return { outcome: "queued", detail: out.trim() };
      return { outcome: "merged", detail: out.trim() || "merged" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A merge-queue-required branch surfaces as an error on older gh; treat as queued when the
      // message says so, otherwise it is a genuine block (conflict, failing gate, perms).
      if (/added to the merge queue|enqueued/i.test(msg)) return { outcome: "queued", detail: msg };
      return { outcome: "blocked", detail: msg };
    }
  }
  if (!token) return null;
  const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ merge_method: opts.method }),
  });
  if (r.ok) {
    // A 2xx from the REST merge endpoint does not guarantee the PR has *landed*: the body's
    // `merged` flag is authoritative, and a merge-queue-required branch is enrolled (not merged)
    // in this pass. Trust `merged` when true; otherwise verify the PR's actual state and report
    // `queued` when it hasn't landed yet, so the merge-loop waits for `merge-landed` rather than
    // marking it merged prematurely.
    const body = (await r.json().catch(() => ({}))) as { merged?: boolean };
    if (body.merged) return { outcome: "merged", detail: "merged" };
    const st = await fetchPrState(repo, number, token).catch(() => null);
    if (st?.merged) return { outcome: "merged", detail: "merged" };
    return { outcome: "queued", detail: "merge accepted; PR not yet landed (awaiting merge queue)" };
  }
  const detail = `github ${r.status} ${r.statusText}: ${(await r.text()).slice(0, 300)}`.trim();
  return { outcome: "blocked", detail };
}
