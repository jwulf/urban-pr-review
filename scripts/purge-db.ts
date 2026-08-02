// deno task purge — wipe the app's sqlite datasource so `deno task start` comes up against a
// fresh schema (the runtime re-applies db/migrations on boot). Deletes the sqlite file and its
// WAL/SHM sidecars for the `app` source declared in nano.app.json.
const url = Deno.env.get("NANO_APP_DB_URL") ?? "file:./app.db";

/** Resolve a `file:` datasource URL to a filesystem path. Handles both the opaque
 *  form (`file:./app.db`, `file:/abs/app.db`) and the authority form
 *  (`file:///abs/app.db`), and refuses non-`file:` schemes. */
function fileUrlToPath(u: string): string {
  if (!u.startsWith("file:")) {
    throw new Error(`purge only supports file: datasource URLs, got: ${u}`);
  }
  // Authority form (`file://host/path` or `file:///path`) parses cleanly as a URL.
  if (u.startsWith("file://")) {
    const parsed = new URL(u);
    if (parsed.hostname && parsed.hostname !== "localhost") {
      throw new Error(
        `purge does not support remote file hosts, got host "${parsed.hostname}" in: ${u}`,
      );
    }
    const p = decodeURIComponent(parsed.pathname);
    // Windows drive fixup: `/C:/x` -> `C:/x`.
    return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
  }
  // Opaque form: everything after the scheme is the (possibly relative) path.
  return u.slice("file:".length);
}

const path = fileUrlToPath(url);

for (const suffix of ["", "-wal", "-shm"]) {
  try {
    await Deno.remove(path + suffix);
    console.log(`removed ${path}${suffix}`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}
console.log("app db purged");
