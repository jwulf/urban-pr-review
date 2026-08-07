// Tests for the /hooks/blackboard endpoint (Tier 1, issues #51 / #49 D4).
import { assertEquals } from "jsr:@std/assert@1";
import type { AppApi } from "@nanobpm/urban";
import handler from "./blackboard.ts";

// deno-lint-ignore no-explicit-any
function memApp(): { app: AppApi; stores: Record<string, any[]> } {
  // deno-lint-ignore no-explicit-any
  const stores: Record<string, any[]> = {};
  const seq: Record<string, number> = {};
  function tbl(name: string, pk = "id") {
    // deno-lint-ignore no-explicit-any
    const rows = (stores[name] ??= [] as any[]);
    return {
      // deno-lint-ignore no-explicit-any require-await
      async insert(row: any) {
        if (pk === "id") {
          const id = (seq[name] = (seq[name] ?? 0) + 1);
          rows.push({ id, ...row });
          return id;
        }
        rows.push({ ...row });
        return row[pk];
      },
      // deno-lint-ignore no-explicit-any require-await
      async find(where: any = {}) {
        return rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      },
      // deno-lint-ignore no-explicit-any require-await
      async findOne(where: any = {}) {
        return rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      },
    };
  }
  // deno-lint-ignore no-explicit-any
  const app = { data: { table: (n: string, pk?: string) => tbl(n, pk) } } as any as AppApi;
  return { app, stores };
}

function req(method: string, query: Record<string, string>) {
  return {
    method,
    path: "/hooks/blackboard",
    query: new URLSearchParams(query),
    headers: new Headers(),
    text: async () => "",
  };
}

async function call(
  app: AppApi,
  method: string,
  query: Record<string, string>,
  body?: unknown,
) {
  // deno-lint-ignore no-explicit-any
  const res = await handler({ req: req(method, query) as any, body }, app);
  // deno-lint-ignore no-explicit-any
  return res as any;
}

async function seedPlan(app: AppApi, planKey: string, token: string) {
  await app.data.table("plans", "plan_key").insert({ plan_key: planKey, blackboard_token: token });
}

Deno.test("missing token → 400", async () => {
  const { app } = memApp();
  assertEquals((await call(app, "GET", {})).status, 400);
});

Deno.test("unknown token → 404 (does not reveal plans)", async () => {
  const { app } = memApp();
  await seedPlan(app, "o/r#1", "good");
  assertEquals((await call(app, "GET", { token: "bad" })).status, 404);
});

Deno.test("POST appends then GET reads back, scoped by the token's plan", async () => {
  const { app } = memApp();
  await seedPlan(app, "o/r#1", "tok");
  const post = await call(app, "POST", { token: "tok" }, {
    author_task: "gap-2",
    kind: "file-claim",
    files: ["engine/tests.rs"],
    body: "appending to shared boilerplate",
  });
  assertEquals(post.status, 201);
  assertEquals(post.body.inserted, true);

  const get = await call(app, "GET", { token: "tok" });
  assertEquals(get.status, 200);
  assertEquals(get.body.planKey, "o/r#1");
  assertEquals(get.body.entries.length, 1);
  assertEquals(get.body.entries[0].files, ["engine/tests.rs"]);
  assertEquals(get.body.entries[0].kind, "file-claim");
});

Deno.test("POST with a blank body → 400", async () => {
  const { app } = memApp();
  await seedPlan(app, "o/r#1", "tok");
  assertEquals((await call(app, "POST", { token: "tok" }, { body: "  " })).status, 400);
});

Deno.test("POST is idempotent on dedupe_key (retry → 200, not a duplicate)", async () => {
  const { app, stores } = memApp();
  await seedPlan(app, "o/r#1", "tok");
  const body = { author_task: "t", body: "claim", dedupe_key: "t:claim:1" };
  assertEquals((await call(app, "POST", { token: "tok" }, body)).status, 201);
  const retry = await call(app, "POST", { token: "tok" }, body);
  assertEquals(retry.status, 200);
  assertEquals(retry.body.inserted, false);
  assertEquals(stores["plan_blackboard"].length, 1);
});

Deno.test("GET ?since returns only newer entries", async () => {
  const { app } = memApp();
  await seedPlan(app, "o/r#1", "tok");
  await call(app, "POST", { token: "tok" }, { body: "one" });
  await call(app, "POST", { token: "tok" }, { body: "two" });
  const all = await call(app, "GET", { token: "tok" });
  const since = String(all.body.entries[0].id);
  const tail = await call(app, "GET", { token: "tok", since });
  assertEquals(tail.body.entries.map((e: { body: string }) => e.body), ["two"]);
});

Deno.test("unsupported method → 405", async () => {
  const { app } = memApp();
  await seedPlan(app, "o/r#1", "tok");
  assertEquals((await call(app, "DELETE", { token: "tok" })).status, 405);
});
