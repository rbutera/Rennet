import { describe, it } from "vitest";
import { mechanicalComposition, renderComposedPrompt, roundCommitRule } from "./handoff-compose";

const CONTEXT_DIR = ".rennet/context/1a3c9f60-0b6f-4d0b-9b3e-4f2f5b7c8d91";

describe("size probe", () => {
  it("prints the round prompt size", () => {
    const bundle = {
      reviewId: "rv",
      patchsetId: "ps",
      tasks: [
        {
          title: "t",
          heading: "h",
          sourceDispositions: ["d1"],
          asks: [
            {
              id: "d1",
              path: "packages/server/src/create-server.ts",
              type: "change" as const,
              instruction: "Do the thing.",
              context: "@@ -1 +1 @@\n-a\n+b",
            },
          ],
        },
      ],
    };
    const tasks = mechanicalComposition(
      { reviewId: "rv", patchsetId: "ps", contextDir: CONTEXT_DIR, tasks: bundle.tasks } as never,
      CONTEXT_DIR,
    ).tasks;
    const prompt = renderComposedPrompt(tasks, CONTEXT_DIR, roundCommitRule("pnpm check"));
    console.log(`ROUND_PROMPT_BYTES=${Buffer.byteLength(prompt, "utf8")}`);
    console.log(prompt);
  });
});
