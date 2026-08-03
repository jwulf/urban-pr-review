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
