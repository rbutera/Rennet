import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScriptedHarnessPlan } from "./scripted-harness-plan";

function writePlan(root: string, plan: unknown): string {
  const path = join(root, "owner-loop-685-plan.json");
  writeFileSync(path, `${JSON.stringify(plan)}\n`);
  return path;
}

async function terminalOutcome(
  port: ReturnType<typeof loadScriptedHarnessPlan>,
  cwd: string,
  prompt: string,
  outputSchema?: unknown,
) {
  const session = await port.createSession({ cwd, ...(outputSchema ? { outputSchema } : {}) });
  await session.send({ prompt });
  for await (const event of session.events) {
    if (event.kind === "session.ended") return event.outcome;
  }
  throw new Error("scripted harness ended without a terminal event");
}

describe("scripted harness JSON plan", () => {
  it("applies each exact edit under SessionSpec.cwd once and resumes its JSONL ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-owner-loop-685-plan-"));
    const repo = join(root, "repo");
    const log = join(root, "owner-loop-685-invocations.jsonl");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/value.ts"), "export const value = 'base';\n");
    const planPath = writePlan(root, {
      schemaVersion: 1,
      lane: "owner-loop-685",
      invocationLog: log,
      steps: [
        {
          id: "round-one",
          kind: "edit",
          promptIncludes: "Set the value to round one",
          edits: [
            {
              path: "src/value.ts",
              from: "export const value = 'base';",
              to: "export const value = 'round-one';",
            },
          ],
          finalText: "round one applied",
        },
        {
          id: "round-two",
          kind: "edit",
          promptIncludes: "Set the value to round two",
          edits: [
            {
              path: "src/value.ts",
              from: "export const value = 'round-one';",
              to: "export const value = 'round-two';",
            },
          ],
          finalText: "round two applied",
        },
      ],
    });

    const first = loadScriptedHarnessPlan(planPath);
    await expect(terminalOutcome(first, repo, "Set the value to round one")).resolves.toMatchObject(
      {
        status: "completed",
        finalText: "round one applied",
      },
    );
    expect(readFileSync(join(repo, "src/value.ts"), "utf8")).toContain("round-one");

    const restarted = loadScriptedHarnessPlan(planPath);
    await expect(
      terminalOutcome(restarted, repo, "Set the value to round two"),
    ).resolves.toMatchObject({ status: "completed", finalText: "round two applied" });
    expect(readFileSync(join(repo, "src/value.ts"), "utf8")).toContain("round-two");

    const records = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => [record.lane, record.stepId, record.cwd])).toEqual([
      ["owner-loop-685", "round-one", repo],
      ["owner-loop-685", "round-two", repo],
    ]);
    await expect(terminalOutcome(restarted, repo, "Set the value to round one")).rejects.toThrow(
      "already consumed",
    );
  });

  it("renders the current patchset into a structured result and echoes post-process input", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-owner-loop-685-structured-"));
    const planPath = writePlan(root, {
      schemaVersion: 1,
      lane: "owner-loop-685",
      invocationLog: join(root, "invocations.jsonl"),
      steps: [
        {
          id: "sequence",
          kind: "structured",
          promptIncludes: "Sequence fixture",
          output: {
            elements: [
              {
                id: "ref",
                kind: "code_ref",
                data: {
                  author: { kind: "lens-agent", id: "owner-loop-685" },
                  patchset_id: "${patchsetId}",
                  path: "src/value.ts",
                  side: "head",
                  start_line: 1,
                  end_line: 1,
                },
              },
            ],
          },
        },
        {
          id: "post-process",
          kind: "echo-board",
          promptIncludes: "Post-process fixture",
        },
      ],
    });
    const port = loadScriptedHarnessPlan(planPath);
    const patchsetId = "patchset-owner-loop-1";
    const drafted = await terminalOutcome(
      port,
      root,
      `Sequence fixture\n<<<rennet:layer context>>>\n${JSON.stringify({ patchset: { id: patchsetId } })}`,
      {},
    );
    expect(drafted).toMatchObject({
      status: "completed",
      structuredOutput: { elements: [{ data: { patchset_id: patchsetId } }] },
    });

    const board = { elements: [{ id: "p", kind: "prose", data: { markdown: "kept" } }] };
    const echoed = await terminalOutcome(
      port,
      root,
      `Post-process fixture\n<<<rennet:layer context>>>\n${JSON.stringify({ board })}\n\n<<<rennet:layer payload>>>\n{}`,
      {},
    );
    expect(echoed).toMatchObject({ status: "completed", structuredOutput: board });
  });

  it("maps every offered requirement to the implementation hunk selected by the plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-owner-loop-685-coverage-"));
    const planPath = writePlan(root, {
      schemaVersion: 1,
      lane: "owner-loop-685",
      invocationLog: join(root, "invocations.jsonl"),
      steps: [
        {
          id: "coverage",
          kind: "coverage",
          promptIncludes: "Map coverage fixture",
          implementationPath: "src/value.ts",
        },
      ],
    });
    const outcome = await terminalOutcome(
      loadScriptedHarnessPlan(planPath),
      root,
      [
        "Map coverage fixture",
        "REQUIREMENTS:",
        JSON.stringify({
          requirements: [{ capability: "owner", requirement: "Keep the value source-backed" }],
        }),
        "",
        "OFFERED HUNKS:",
        JSON.stringify({
          hunks: [
            { id: "implementation", filePath: "src/value.ts" },
            { id: "unrelated", filePath: "src/other.ts" },
          ],
        }),
      ].join("\n"),
      {},
    );

    expect(outcome).toMatchObject({
      status: "completed",
      structuredOutput: {
        mappings: [
          {
            capability: "owner",
            requirement: "Keep the value source-backed",
            hunks: ["implementation"],
            testHunks: [],
          },
        ],
      },
    });
  });

  it("rejects invalid plans and repository escapes before creating a session", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-owner-loop-685-invalid-"));
    expect(() =>
      loadScriptedHarnessPlan(
        writePlan(root, {
          schemaVersion: 1,
          lane: "owner-loop-685",
          invocationLog: join(root, "invocations.jsonl"),
          steps: [
            {
              id: "escape",
              kind: "edit",
              promptIncludes: "escape",
              edits: [{ path: "../outside.ts", from: "a", to: "b" }],
              finalText: "bad",
            },
          ],
        }),
      ),
    ).toThrow("Invalid scripted harness plan");
  });
});
