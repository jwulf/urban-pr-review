// deno task purge — wipe the app's sqlite datasource so `deno task start` comes up against a
// fresh schema (the runtime re-applies db/migrations on boot). Deletes the sqlite file and its
// WAL/SHM sidecars for the `app` source declared in nano.app.json.
const url = Deno.env.get("NANO_APP_DB_URL") ?? "file:./app.db";
const path = url.replace(/^file:/, "");

for (const suffix of ["", "-wal", "-shm"]) {
  try {
    await Deno.remove(path + suffix);
    console.log(`removed ${path}${suffix}`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}
console.log("app db purged");
