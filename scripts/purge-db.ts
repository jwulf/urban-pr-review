// npm run purge — wipe the app's sqlite datasource so `npm start` comes up against a fresh
// schema (the runtime re-applies db/migrations on boot). Deletes the sqlite file and its
// WAL/SHM sidecars for the `app` source declared in nano.app.json.
import { rmSync } from "node:fs";

const url = process.env.NANO_APP_DB_URL ?? "file:./app.db";

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
  // Decode percent-escapes too (mirroring the authority branch above), so an
  // encoded path like `file:./my%20app.db` resolves to `./my app.db`.
  const p = decodeURIComponent(u.slice("file:".length));
  // Windows single-slash absolute form (`file:/C:/x`): strip the leading slash.
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
}

const path = fileUrlToPath(url);

for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync(path + suffix);
    console.log(`removed ${path}${suffix}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
console.log("app db purged");
