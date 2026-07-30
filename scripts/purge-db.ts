// `deno task purge` — reset the app database to a clean, freshly-migrated state.
//
// The engine (Zeebe/nano) and the app database are two separate stores: when you
// wipe the engine's journal (`rm -rf ~/nano-data`) the app's sqlite still holds
// stale `pull_requests`/`rounds`/`escalations` rows pointing at process instances
// that no longer exist. This task drops the app's sqlite file(s) and re-applies
// `db/migrations`, so `deno task start` comes up against an empty, correct schema.
//
// It resolves the datasource the same way the app does (the manifest's `app`
// source + `NANO_APP_DB_URL`), so it always targets the real file — never a guess.
import { listSources, sqlitePath } from "@nanobpm/data";

async function rm(path: string): Promise<boolean> {
  try {
    await Deno.remove(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

const root = Deno.cwd();
const { default: def, sources } = await listSources();
const source = sources.find((s) => s.name === def) ?? sources[0];
if (!source) {
  console.error("purge: no datasource declared in the manifest");
  Deno.exit(1);
}
if (source.driver !== "sqlite") {
  console.error(`purge: refusing to purge a non-sqlite datasource (${source.driver})`);
  Deno.exit(1);
}

const dbPath = sqlitePath(source.url, root);
// Remove the main DB and its WAL/SHM sidecars (SQLite in WAL mode).
const removed: string[] = [];
for (const suffix of ["", "-wal", "-shm"]) {
  if (await rm(dbPath + suffix)) removed.push(dbPath + suffix);
}
console.log(
  removed.length ? `purge: removed ${removed.join(", ")}` : "purge: no existing db files",
);

// Re-apply migrations via the generated data gateway (recreates the schema + the
// `_nano_migrations` ledger), so the next `start` doesn't have to.
const cmd = new Deno.Command("deno", {
  args: ["run", "--allow-read", "--allow-write", "--allow-env", "nano-generated/data-cli.ts"],
  stdin: "piped",
  stdout: "piped",
  stderr: "inherit",
});
const child = cmd.spawn();
const w = child.stdin.getWriter();
await w.write(new TextEncoder().encode(JSON.stringify({ op: "migrate" })));
await w.close();
const { code, stdout } = await child.output();
const out = new TextDecoder().decode(stdout).trim();
try {
  const parsed = JSON.parse(out) as { ok: boolean; applied?: string[]; error?: string };
  if (!parsed.ok) {
    console.error(`purge: migrate failed: ${parsed.error}`);
    Deno.exit(1);
  }
  console.log(`purge: migrated (${(parsed.applied ?? []).length} file(s) applied)`);
} catch {
  console.error(`purge: unexpected migrate output: ${out}`);
  Deno.exit(code || 1);
}
console.log("purge: app database is clean.");
