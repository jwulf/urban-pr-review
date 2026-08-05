// The per-submit round-cap coercion, kept as a pure module (no env, no I/O) so it is trivially
// testable — mirrors app/waves.ts. `service.ts` builds the fleet default MAX_ROUNDS on top of it,
// and the submit form / webhook / start action each pass a caller-supplied override through it.

/** Upper bound on the review-round cap. A cap of 0 would escalate before the first round; an
 * unbounded cap could run the agent (and its cost) indefinitely, so overrides are clamped here. */
export const MAX_ROUNDS_CEILING = 100;

/** Coerce an arbitrary caller-supplied round cap into a sane positive integer, falling back to
 * `fallback` when the value is absent, blank, non-numeric, zero/negative, or NaN. The submit form
 * sends strings (the runtime renders every field as text), so this accepts `string | number |
 * unknown`. Values above MAX_ROUNDS_CEILING are clamped down rather than rejected. */
export function clampRounds(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < 1) return fallback;
  return Math.min(i, MAX_ROUNDS_CEILING);
}
