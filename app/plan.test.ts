// Red/green regression for the plan-review round-cap parsing (PR #26 review).
//
// `MAX_PLAN_REVIEW_ROUNDS` bounds the adversarial revise loop. If the env override parsed to
// `NaN`/`0` (e.g. unset, "", "abc"), the cap check `round + 1 >= cap` would never fire and the
// planner could revise forever. `positiveIntEnv` must fall back to the default on any value that
// is not a positive integer, so the loop is always bounded.
import { assertEquals } from "jsr:@std/assert@1";
import { positiveIntEnv } from "./plan.ts";

const KEY = "NANO_PLAN_REVIEW_ROUNDS_TEST";

function withEnv(value: string | undefined, run: () => void) {
  const had = Object.prototype.hasOwnProperty.call(Deno.env.toObject(), KEY);
  const prev = Deno.env.get(KEY);
  try {
    if (value === undefined) Deno.env.delete(KEY);
    else Deno.env.set(KEY, value);
    run();
  } finally {
    if (had && prev !== undefined) Deno.env.set(KEY, prev);
    else Deno.env.delete(KEY);
  }
}

Deno.test("unset → fallback (bounded loop, never NaN)", () => {
  withEnv(undefined, () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

Deno.test("blank/whitespace → fallback, not 0", () => {
  withEnv("", () => assertEquals(positiveIntEnv(KEY, 3), 3));
  withEnv("   ", () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

Deno.test("non-numeric → fallback, not NaN", () => {
  withEnv("abc", () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

Deno.test("zero and negatives → fallback (cap must be >= 1)", () => {
  withEnv("0", () => assertEquals(positiveIntEnv(KEY, 3), 3));
  withEnv("-2", () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

Deno.test("non-integer → fallback", () => {
  withEnv("2.5", () => assertEquals(positiveIntEnv(KEY, 3), 3));
});

Deno.test("valid positive integer → honoured", () => {
  withEnv("5", () => assertEquals(positiveIntEnv(KEY, 3), 5));
  withEnv("1", () => assertEquals(positiveIntEnv(KEY, 3), 1));
});
