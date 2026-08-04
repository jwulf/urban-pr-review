// Red/green regression for the plan levelizer (issue #20). Run with `deno test`.
//
// One `Deno.test` = one named property of computeWaves. These encode the wave
// contract: independent tasks share wave 0 (all-parallel), a chain steps 0,1,2…
// (all-sequential), a diamond re-converges, and a malformed graph is rejected
// rather than silently mis-levelized.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { computeWaves, WaveError, type WaveTask } from "./waves.ts";

Deno.test("no dependencies → every task in wave 0 (fully parallel)", () => {
  const tasks: WaveTask[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const { waves, waveCount } = computeWaves(tasks);
  assertEquals(waveCount, 1);
  assertEquals(waves, [["a", "b", "c"]]);
});

Deno.test("linear chain → one task per wave (fully sequential)", () => {
  const tasks: WaveTask[] = [
    { id: "a" },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: ["b"] },
  ];
  const { waves, waveCount, waveOf } = computeWaves(tasks);
  assertEquals(waveCount, 3);
  assertEquals(waves, [["a"], ["b"], ["c"]]);
  assertEquals([waveOf.get("a"), waveOf.get("b"), waveOf.get("c")], [0, 1, 2]);
});

Deno.test("diamond → longest-path level; join waits for both arms", () => {
  const tasks: WaveTask[] = [
    { id: "a" },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: ["a"] },
    { id: "d", dependsOn: ["b", "c"] },
  ];
  const { waves, waveCount } = computeWaves(tasks);
  assertEquals(waveCount, 3);
  assertEquals(waves, [["a"], ["b", "c"], ["d"]]);
});

Deno.test("mixed graph → level is 1 + max(dep level), not 1 + min", () => {
  // e depends on a (wave 0) and d (wave 2) → must land in wave 3, behind the deeper dep.
  const tasks: WaveTask[] = [
    { id: "a" },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: ["b"] },
    { id: "d", dependsOn: ["c"] },
    { id: "e", dependsOn: ["a", "d"] },
  ];
  const { waveOf, waveCount } = computeWaves(tasks);
  assertEquals(waveCount, 5);
  assertEquals(waveOf.get("e"), 4);
});

Deno.test("empty plan → zero waves", () => {
  const { waves, waveCount } = computeWaves([]);
  assertEquals(waveCount, 0);
  assertEquals(waves, []);
});

Deno.test("blank / whitespace dependsOn entries are ignored", () => {
  const tasks: WaveTask[] = [{ id: "a", dependsOn: ["", "  "] }];
  const { waves, waveCount } = computeWaves(tasks);
  assertEquals(waveCount, 1);
  assertEquals(waves, [["a"]]);
});

Deno.test("dependency cycle → WaveError", () => {
  const tasks: WaveTask[] = [
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["a"] },
  ];
  assertThrows(() => computeWaves(tasks), WaveError, "cycle");
});

Deno.test("self-dependency → WaveError", () => {
  assertThrows(() => computeWaves([{ id: "a", dependsOn: ["a"] }]), WaveError, "itself");
});

Deno.test("unknown dependency id → WaveError", () => {
  assertThrows(
    () => computeWaves([{ id: "a", dependsOn: ["ghost"] }]),
    WaveError,
    "unknown task",
  );
});

Deno.test("duplicate task id → WaveError", () => {
  assertThrows(
    () => computeWaves([{ id: "a" }, { id: "a" }]),
    WaveError,
    "duplicate",
  );
});
