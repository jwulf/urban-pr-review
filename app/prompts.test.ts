// Contract for the prompt-delivery bridge (app/prompts.ts). The base agent prompts must be
// readable from the deployed project root so the host can seed them as process variables while
// the engine does not deliver BPMN task headers. Run with `deno test -A`.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { _resetPromptCache, readPrompt } from "./prompts.ts";

Deno.test("readPrompt reads the review-round base prompt (incl. the result-file contract)", async () => {
  _resetPromptCache();
  const text = await readPrompt("review-round");
  assert(text.length > 0, "review-round.md must be non-empty");
  assert(text.includes("AGENT_RESULT_FILE"), "must carry the $AGENT_RESULT_FILE result contract");
});

Deno.test("readPrompt resolves every agent stem the models template", async () => {
  _resetPromptCache();
  for (const stem of ["review-round", "plan", "plan-review", "feature", "fix-ci"]) {
    const text = await readPrompt(stem);
    assert(text.length > 0, `prompts/${stem}.md must be non-empty (delivered as a variable)`);
  }
});

Deno.test("readPrompt of a missing stem degrades to empty (never throws / blocks create)", async () => {
  _resetPromptCache();
  assertEquals(await readPrompt("does-not-exist"), "");
});
