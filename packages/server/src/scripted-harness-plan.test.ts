import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OWNER_LOOP_ROUND_ONE_ASK, ownerLoopScriptedHarnessPlan } from "./owner-loop-proof-fixture";
import { loadScriptedHarnessPlan, loadScriptedT3Seats } from "./scripted-harness-plan";

const askPlanValue = `\${askId}`;
const evidenceIdsPlanValue = `\${evidenceIds}`;
const patchsetPlanValue = `\${patchsetId}`;

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
  it("keeps the owner-loop report fixture on the production classification envelope", () => {
    const patchsetId = "owner-loop-successor";
    const reportStep = ownerLoopScriptedHarnessPlan("/tmp/owner-loop-invocations.jsonl").steps.find(
      (step) => step.id === "report-round-one",
    );
    if (reportStep?.kind !== "structured") throw new Error("round-one report step is missing");
    const output = JSON.parse(
      JSON.stringify(reportStep.output)
        .replaceAll(patchsetPlanValue, patchsetId)
        .replaceAll(askPlanValue, OWNER_LOOP_ROUND_ONE_ASK),
    );
    expect(output).toEqual({
      outcomes: [
        {
          askId: OWNER_LOOP_ROUND_ONE_ASK,
          status: "addressed",
          note: "`src/owner.ts` now exports `round-one`.",
          // The fixture asks for the round's MEASURED evidence ids rather than naming
          // a line: content-derived ids cannot be hard-coded in a scripted plan.
          evidenceIds: evidenceIdsPlanValue,
        },
      ],
      beyond: [],
    });
  });

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
        harnessSessionId: "owner-loop-685:round-one",
        lastAssistantMessageAnchor: "round-one",
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

  // #681 / C14 D3. The launched-app spec asserts the executing provider by reading this
  // ledger, but that spec cannot currently reach the assertion: BOTH legs fail at round
  // one on a pre-existing `verifyAskPath` defect, proven identical at this branch's base.
  // So the mechanism it depends on is control-proven HERE instead, at the level where it
  // actually lives: the ledger's `harness` must come from the SESSION that ran the turn,
  // not from the plan or the port descriptor — the two things the app's own receipt
  // already reads, which is why they cannot corroborate it.
  //
  // TWO POSITIVE CONTROLS (both run 2026-09-01, restored after), because one was not
  // enough: the first reddens too early to prove the last assertion.
  //  1. `new ScriptedHarnessSession("claude-code", ...)` in `loadScriptedHarnessPlan`,
  //     descriptor left at `harness`. `port.descriptor.id` stays green — the resolver, and
  //     therefore the app's receipt, still reads Codex — and `session.harness` reddens.
  //     But it reddens THERE, so it says nothing about the ledger line.
  //  2. `harness: "claude-code"` in place of `harness: executingHarness` in the
  //     `recordInvocation` call. Descriptor, session, and event all stay green, and ONLY
  //     the ledger assertion reddens — which is the one the launched-app spec reads.
  it("records the executing session's own provider in the ledger, not the plan's", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-scripted-provider-"));
    const log = join(root, "provider-invocations.jsonl");
    const planPath = writePlan(root, {
      schemaVersion: 1,
      lane: "provider-proof",
      harness: "codex",
      invocationLog: log,
      steps: [
        {
          id: "structured-turn",
          kind: "structured",
          promptIncludes: "Report the provider",
          output: { ok: true },
        },
      ],
    });

    const port = loadScriptedHarnessPlan(planPath);
    expect(port.descriptor.id).toBe("codex");
    const session = await port.createSession({ cwd: root, outputSchema: {} });
    // The session's own declaration, and the event it emits, before any ledger read.
    expect(session.harness).toBe("codex");
    await session.send({ prompt: "Report the provider" });
    for await (const event of session.events) {
      if (event.kind === "session.ended") expect(event.harness).toBe("codex");
    }

    const records = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => [record.stepId, record.harness])).toEqual([
      ["structured-turn", "codex"],
    ]);
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
          promptIncludes: ["Sequence fixture", '"dispatchedAsks"'],
          output: {
            ask: askPlanValue,
            elements: [
              {
                id: "ref",
                kind: "code_ref",
                data: {
                  author: { kind: "lens-agent", id: "owner-loop-685" },
                  patchset_id: patchsetPlanValue,
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
    const askId = "ask-owner-loop-1";
    const drafted = await terminalOutcome(
      port,
      root,
      `Sequence fixture\n<<<rennet:layer context>>>\n${JSON.stringify({ patchset: { id: patchsetId }, round: { dispatchedAsks: [{ id: askId }] } })}`,
      {},
    );
    expect(drafted).toMatchObject({
      status: "completed",
      structuredOutput: { ask: askId, elements: [{ data: { patchset_id: patchsetId } }] },
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

  it("answers a repair turn on the thread that already holds the draft", async () => {
    // A repair turn carries LINT POINTERS and no prompt file, so `selectStep` over that turn
    // alone matches nothing and the seat would settle "no step for this prompt" with the
    // unrepaired draft kept (PR #800). The thread remembers its own board, so the step is
    // chosen from the whole conversation and the drafting step answers again.
    const root = mkdtempSync(join(tmpdir(), "rennet-scripted-seat-repair-"));
    const seats = loadScriptedT3Seats(
      writePlan(root, {
        schemaVersion: 1,
        lane: "owner-loop-685",
        invocationLog: join(root, "invocations.jsonl"),
        steps: [
          {
            id: "draft-sequence",
            kind: "structured",
            promptIncludes: "Sequence fixture",
            output: { elements: [{ id: "p", kind: "prose", data: { markdown: "drafted" } }] },
          },
        ],
      }),
    );
    const runtime = await seats.resolve({
      repoRoot: root,
      generationId: "gen-1",
      branch: "feature/x",
      sessionId: "session-1",
    });
    const client = await runtime.seam.client();
    const { threadId } = await runtime.seam.threadFor({
      seat: "sequence",
      provider: "claudeAgent",
      model: "opus",
      effort: "medium",
    });
    const outputSchema = { type: "object" };
    await client.startTurn({ threadId, text: "Sequence fixture", outputSchema });
    await client.waitForTurnSettled(threadId);
    // Pointers only — nothing in this text matches any step on its own.
    await client.startTurn({
      threadId,
      text: "repair: element p failed lint at .data.markdown",
      outputSchema,
    });
    const repaired = await client.waitForTurnSettled(threadId);
    expect(repaired.state).toBe("completed");
    expect(repaired.structuredOutput).toEqual({
      elements: [{ id: "p", kind: "prose", data: { markdown: "drafted" } }],
    });
    expect(seats.threads).toHaveLength(1);
    expect(seats.threads[0]?.prompts).toHaveLength(2);
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

  it("keeps scripted owner-loop responses out of the production CLI bundle", () => {
    const productionBundle = readFileSync(new URL("../dist/rennet.cjs", import.meta.url), "utf8");
    for (const marker of [
      "scripted-harness",
      "owner-loop-685",
      "RENNET_OWNER_LOOP_PLAN",
      "685-scripted-v1",
    ]) {
      expect(productionBundle).not.toContain(marker);
    }
  });
});
