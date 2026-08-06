// Prompt-delivery bridge — carry agent base prompts as process variables.
//
// The `prompts/*.md` files are the single source of truth for every agent's base prompt. The
// model templates them into each service task's `io.nanobpm.agentTask.task.prompt` header at
// deploy time (`models.templates` in nano.app.json). BUT the nano engine does not (yet) deliver
// BPMN `zeebe:taskHeaders` to workers on job activation — a remote harness activates the job
// with empty `customHeaders`, so the header-borne base prompt never reaches the agent and it
// improvises (the "no result → blank escalation" failure on resubmit). See the engine-side
// `taskHeaders → customHeaders` (Camunda parity) work in Magikcraft/nano-bpm.
//
// Until that engine feature ships, the host also reads these same files and seeds the base
// prompt as a process variable that the harness's `variables.prompt` fallback picks up
// (c8ctl normalizeTaskEnvelope: `task.prompt ?? variables.prompt ?? variables.task`). When the
// engine does deliver headers, the header `task.prompt` takes precedence over this variable and
// the content is identical, so this bridge is harmless to leave in place.
//
// REMOVE THIS BRIDGE once the engine delivers customHeaders and the agents are upgraded:
// tracked in jwulf/urban-pr-review#36.
//
// Host-agnostic read: the compiled/Deno host uses `Deno.readTextFile`; the Node host
// (main.ts on the deployed box) falls back to `node:fs`.

const cache = new Map<string, string>();

/** Read `prompts/<stem>.md` once (cached) and return its text, or "" if it cannot be read.
 * A read failure must never block instance creation — an empty base prompt degrades to the
 * prior header-only behaviour rather than throwing. */
export async function readPrompt(stem: string): Promise<string> {
  const hit = cache.get(stem);
  if (hit !== undefined) return hit;
  const path = `prompts/${stem}.md`;
  try {
    const g = globalThis as { Deno?: { readTextFile(p: string): Promise<string> } };
    const text = g.Deno?.readTextFile
      ? await g.Deno.readTextFile(path)
      : await (await import("node:fs/promises")).readFile(path, "utf8");
    cache.set(stem, text);
    return text;
  } catch (err) {
    console.warn(`[prompts] could not read ${path}: ${err}`);
    return "";
  }
}

/** Test seam: clear the module read cache so a unit test can stub `prompts/*.md` reads. */
export function _resetPromptCache() {
  cache.clear();
}
