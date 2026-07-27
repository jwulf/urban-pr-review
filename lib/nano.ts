// Shared bootstrap helpers for the Urban app. Imported via @lib/nano.ts.
// Keeps main.ts free of deploy/worker plumbing.

/// Base URL of the engine; honours NANOBPMN_BASE_URL, defaults to localhost.
export const BASE_URL = (Deno.env.get("NANOBPMN_BASE_URL") ?? "http://localhost:8080").replace(/\/+$/, "");

/// Deploys every BPMN process under resources/processes/ to the engine. Returns
/// the number of resources deployed (0 if the folder is empty/missing).
export async function deployAllResources(): Promise<number> {
  const dir = "resources/processes";
  const form = new FormData();
  let count = 0;
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".bpmn")) continue;
      const xml = await Deno.readTextFile(`${dir}/${e.name}`);
      form.append("resources", new Blob([xml], { type: "text/xml" }), e.name);
      count++;
    }
  } catch {
    return 0; // no processes folder yet
  }
  if (count === 0) return 0;
  const res = await fetch(`${BASE_URL}/v2/deployments`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`deployment failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  console.log(`deployed ${count} process(es) to ${BASE_URL}/v2`);
  return count;
}

/// Workers to start: a directory name list to `include` or `exclude`; omit to
/// start every worker under workers/.
export type WorkerSelection = { exclude: string[] } | { include: string[] };

/// Starts each selected worker by importing its worker.ts. Returns the names
/// started. Workers self-register via defineWorker(); failures are logged, not
/// fatal.
export async function startWorkers(workers?: WorkerSelection): Promise<string[]> {
  let names: string[] = [];
  try {
    for await (const e of Deno.readDir("workers")) {
      if (e.isDirectory) names.push(e.name);
    }
  } catch {
    return []; // no workers folder yet
  }
  if (workers && "include" in workers) {
    const set = new Set(workers.include);
    names = names.filter((n) => set.has(n));
  } else if (workers && "exclude" in workers) {
    const set = new Set(workers.exclude);
    names = names.filter((n) => !set.has(n));
  }
  names.sort();
  const started: string[] = [];
  for (const name of names) {
    try {
      Deno.env.set("NANOBPMN_BASE_URL", BASE_URL);
      Deno.env.set("NANOBPMN_WORKER_NAME", name);
      await import(`../workers/${name}/worker.ts`);
      console.log(`started worker: ${name}`);
      started.push(name);
    } catch (err) {
      console.error(`worker ${name} failed to start: ${err}`);
    }
  }
  return started;
}

/// Starts every LLM-as-worker declared in the manifest (workers[] entries with
/// an `llm` binding). A no-op ([]) when there is none — urban-pr-review has no
/// llm workers (its agent is a decoupled external service task), so this returns
/// [] without importing the llm pack.
export async function startLlmWorkers(manifestPath = "./nano.app.json"): Promise<string[]> {
  let manifest;
  try {
    manifest = JSON.parse(await Deno.readTextFile(manifestPath));
  } catch {
    return []; // no manifest — nothing to start
  }
  if (!Array.isArray(manifest.workers) || !manifest.workers.some((w: { llm?: string }) => w.llm)) {
    return [];
  }
  const { startLlmWorkers: start } = await import("@nanobpm/llm");
  const started = await start({ manifest, baseUrl: BASE_URL });
  if (started.length) console.log(`started ${started.length} llm worker(s): ${started.join(", ")}`);
  return started;
}
