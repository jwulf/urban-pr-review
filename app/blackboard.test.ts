// Unit tests for the epic coordination blackboard (Tier 1, issues #51 / #49 D4).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { DataLayer } from "@nanobpm/urban";
import {
  appendEntry,
  blackboardUrl,
  mintBlackboardToken,
  normalizeKind,
  planKeyForToken,
  publicBaseUrl,
  readBlackboard,
  renderCoordinationBrief,
} from "./blackboard.ts";

// A tiny in-memory stand-in for the record gateway, matching the subset of the Table<T> API the
// blackboard uses (insert/find/findOne). Mirrors the fake-app style used across the app tests.
// deno-lint-ignore no-explicit-any
function memData(): { data: DataLayer; stores: Record<string, any[]> } {
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
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as any as DataLayer;
  return { data, stores };
}

Deno.test("mintBlackboardToken: URL-safe, unguessable, unique", () => {
  const a = mintBlackboardToken();
  const b = mintBlackboardToken();
  assert(a !== b, "two mints must differ");
  assert(/^[A-Za-z0-9_-]+$/.test(a), `token must be URL-safe base64url, got ${a}`);
  assert(a.length >= 32, "token should carry enough entropy");
});

Deno.test("publicBaseUrl: honours the env override and trims a trailing slash", () => {
  assertEquals(publicBaseUrl("https://pr.example.com/"), "https://pr.example.com");
  assertEquals(publicBaseUrl("https://pr.example.com///"), "https://pr.example.com");
});

Deno.test("publicBaseUrl: a blank/whitespace override falls back instead of yielding a bad URL", () => {
  const prev = process.env.NANO_PR_BASE_URL;
  delete process.env.NANO_PR_BASE_URL;
  try {
    assertEquals(publicBaseUrl(""), "http://localhost:3000");
    assertEquals(publicBaseUrl("   "), "http://localhost:3000");
    assertEquals(blackboardUrl("t", publicBaseUrl("")), "http://localhost:3000/hooks/blackboard?token=t");
  } finally {
    if (prev === undefined) delete process.env.NANO_PR_BASE_URL;
    else process.env.NANO_PR_BASE_URL = prev;
  }
});

Deno.test("blackboardUrl: capability token rides the query string", () => {
  assertEquals(
    blackboardUrl("tok+en/x", "https://h"),
    "https://h/hooks/blackboard?token=tok%2Ben%2Fx",
  );
});

Deno.test("normalizeKind: valid passes through, anything else becomes note", () => {
  assertEquals(normalizeKind("file-claim"), "file-claim");
  assertEquals(normalizeKind("constraint-change"), "constraint-change");
  assertEquals(normalizeKind("bogus"), "note");
  assertEquals(normalizeKind(undefined), "note");
});

Deno.test("renderCoordinationBrief: leads with a separator and teaches the protocol + URL", () => {
  const url = "https://h/hooks/blackboard?token=abc";
  const brief = renderCoordinationBrief(url);
  assert(brief.startsWith("\n\n---"), "must own a leading separator (appendPrompt adds none)");
  assertStringIncludes(brief, url);
  // read + write halves of the protocol
  assertStringIncludes(brief, "curl -s");
  assertStringIncludes(brief, "-X POST");
  assertStringIncludes(brief, "author_task");
  assertStringIncludes(brief, "file-claim");
  assertStringIncludes(brief, "dedupe_key");
});

Deno.test("planKeyForToken: resolves a token to its plan, undefined otherwise", async () => {
  const { data } = memData();
  await data.table("plans", "plan_key").insert({ plan_key: "o/r#7", blackboard_token: "tok7" });
  assertEquals(await planKeyForToken(data, "tok7"), "o/r#7");
  assertEquals(await planKeyForToken(data, "nope"), undefined);
  assertEquals(await planKeyForToken(data, ""), undefined);
});

Deno.test("appendEntry + readBlackboard: append, encode files, read back in write order", async () => {
  const { data } = memData();
  await appendEntry(data, "o/r#1", { author_task: "gap-2", kind: "file-claim", files: ["a.rs"], body: "touches a.rs" });
  await appendEntry(data, "o/r#1", { author_task: "gap-8", kind: "note", body: "heads up" });
  await appendEntry(data, "o/r#2", { body: "other plan" }); // must not leak across plans

  const entries = await readBlackboard(data, "o/r#1");
  assertEquals(entries.map((e) => e.author_task), ["gap-2", "gap-8"], "write order, scoped to plan");
  assertEquals(entries[0].files, ["a.rs"], "files decoded to an array");
  assertEquals(entries[1].files, [], "no files → empty array");
  assertEquals(entries[1].author_task, "gap-8");
});

Deno.test("appendEntry: a missing author defaults to 'system' and kind is normalised", async () => {
  const { data } = memData();
  await appendEntry(data, "p", { body: "x", kind: "weird" as unknown });
  const [e] = await readBlackboard(data, "p");
  assertEquals(e.author_task, "system");
  assertEquals(e.kind, "note");
});

Deno.test("appendEntry: idempotent on dedupe_key (a job retry re-POST is a no-op)", async () => {
  const { data, stores } = memData();
  const first = await appendEntry(data, "p", { author_task: "t", body: "claim", dedupe_key: "t:claim:1" });
  const again = await appendEntry(data, "p", { author_task: "t", body: "claim", dedupe_key: "t:claim:1" });
  assertEquals(first.inserted, true);
  assertEquals(again.inserted, false, "second write with same dedupe_key is a no-op");
  assertEquals(again.id, first.id, "returns the existing id");
  assertEquals(stores["plan_blackboard"].length, 1, "exactly one row persisted");
});

Deno.test("appendEntry: a lost UNIQUE race collapses to a no-op instead of a 500", async () => {
  // Simulate the concurrency window: two POSTs share a dedupe_key, both miss the findOne
  // pre-check, then insert loses the race on the UNIQUE (plan_key, dedupe_key) index. The
  // catch branch must re-read the winner's row and return it rather than propagate the throw.
  const winner = { id: 42, plan_key: "p", dedupe_key: "t:claim:1", author_task: "t", body: "claim" };
  let preCheckDone = false;
  // deno-lint-ignore no-explicit-any
  const table: any = {
    // deno-lint-ignore require-await
    async findOne() {
      // Pre-check misses (row not yet visible); the recovery read after the collision hits.
      if (!preCheckDone) {
        preCheckDone = true;
        return undefined;
      }
      return winner;
    },
    // deno-lint-ignore require-await
    async insert() {
      throw Object.assign(new Error("UNIQUE constraint failed: plan_blackboard.dedupe_key"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
    },
  };
  // deno-lint-ignore no-explicit-any
  const data = { table: () => table } as any as DataLayer;
  const res = await appendEntry(data, "p", { author_task: "t", body: "claim", dedupe_key: "t:claim:1" });
  assertEquals(res.inserted, false, "a lost race is not a fresh insert");
  assertEquals(res.id, 42, "returns the winning row's id");
});

Deno.test("appendEntry: a blank body is rejected", async () => {
  const { data } = memData();
  let threw = false;
  try {
    await appendEntry(data, "p", { body: "   " });
  } catch {
    threw = true;
  }
  assert(threw, "blank body must throw");
});

Deno.test("readBlackboard: since returns only newer entries (incremental poll)", async () => {
  const { data } = memData();
  await appendEntry(data, "p", { body: "one" });
  await appendEntry(data, "p", { body: "two" });
  await appendEntry(data, "p", { body: "three" });
  const all = await readBlackboard(data, "p");
  const tail = await readBlackboard(data, "p", { since: all[0].id });
  assertEquals(tail.map((e) => e.body), ["two", "three"]);
});
