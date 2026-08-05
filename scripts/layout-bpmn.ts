// npm run layout <file.bpmn ...> (or `deno task layout <file.bpmn ...>`) — (re)generate the
// bpmndi:BPMNDiagram for one or more BPMN models using the urban toolkit's `layoutBpmn`
// (bpmn-auto-layout). The semantic model stays authoritative: author the process elements
// (tasks, gateways, flows, zeebe extensions) and run this to derive an auto-laid-out diagram,
// rather than hand-editing DI. Works on DI-less or already-laid-out input; only the diagram is
// (re)written — the semantic model round-trips 1:1. Re-run whenever the flow changes.
import { layoutBpmn } from "@nanobpm/urban";

// Host-agnostic file I/O: Deno inside a compiled binary, else node:fs under Node — mirrors
// app/plan.ts's readAsset seam so this runs the same under `npm run` and `deno task`.
const g = globalThis as {
  Deno?: {
    args: string[];
    readTextFile(p: string): Promise<string>;
    writeTextFile(p: string, s: string): Promise<void>;
  };
};

async function readText(path: string): Promise<string> {
  return g.Deno?.readTextFile
    ? await g.Deno.readTextFile(path)
    : await (await import("node:fs/promises")).readFile(path, "utf8");
}
async function writeText(path: string, text: string): Promise<void> {
  if (g.Deno?.writeTextFile) return await g.Deno.writeTextFile(path, text);
  await (await import("node:fs/promises")).writeFile(path, text, "utf8");
}

// Count the shapes/edges the layout produced, so the run reports what it drew (matches the
// "N shapes + M edges" accounting used when merge-loop's DI was first generated, #18).
const countDi = (xml: string) => ({
  shapes: (xml.match(/<bpmndi:BPMNShape\b/g) ?? []).length,
  edges: (xml.match(/<bpmndi:BPMNEdge\b/g) ?? []).length,
});

async function main() {
  const files = g.Deno?.args ?? process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: layout-bpmn <file.bpmn> [more.bpmn ...]");
    if (g.Deno) g.Deno && (globalThis as { Deno?: { exit(c: number): never } }).Deno!.exit(2);
    else process.exit(2);
    return;
  }
  for (const file of files) {
    const laid = await layoutBpmn(await readText(file));
    await writeText(file, laid);
    const { shapes, edges } = countDi(laid);
    console.log(`[layout] ${file}: ${shapes} shapes + ${edges} edges`);
  }
}

await main();
