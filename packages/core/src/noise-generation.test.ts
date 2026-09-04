import type { PatchFile, Patchset, RspCapabilitySnapshot } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { decompose } from "./decomposition";
import { inlineContextViolation } from "./harness-run-turn";
import { createInvocationBudget } from "./invocation-budget";
import {
  NOISE_OFFER_FILE,
  NOISE_PROJECT_CONTEXT_FILE,
  type NoiseContextFile,
  type NoiseProvenanceSeed,
  type NoiseTurnResult,
  renderNoiseOffer,
  runNoiseAngle,
} from "./noise-generation";
import { buildOfferedManifest } from "./offered-manifest";

// ── A tiny real changeset: a lockfile hunk + two source hunks ────────────────

function file(path: string, patch: string, extra: Partial<PatchFile> = {}): PatchFile {
  return {
    path,
    status: "modified",
    additions: null,
    deletions: null,
    binary: false,
    patch,
    ...extra,
  };
}

function patch(path: string, lines: string[]): string {
  const oldCount = lines.filter((l) => l[0] === "-" || l[0] === " ").length;
  const newCount = lines.filter((l) => l[0] === "+" || l[0] === " ").length;
  return (
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
    `@@ -1,${oldCount} +1,${newCount} @@\n${lines.join("\n")}\n`
  );
}

const PATCHSET: Patchset = {
  id: "ps_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "origin/main",
    baseOid: "0".repeat(40),
    headOid: "1".repeat(40),
  },
  files: [
    file("pnpm-lock.yaml", patch("pnpm-lock.yaml", ["+  resolution: {integrity: sha512-xxx}"])),
    file("src/a.ts", patch("src/a.ts", ["+export const a = 1;"])),
    file("src/b.ts", patch("src/b.ts", ['+import { a } from "./a";', "+export const b = a + 1;"])),
  ],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

const DECOMPOSITION = decompose(PATCHSET);
const MANIFEST = buildOfferedManifest(DECOMPOSITION);
/** Two real offered hunk ids — the ids the RUNNER mints anchors from, never the model. */
const OFFERED_A = MANIFEST.occurrences[0]?.id ?? "h1";
const OFFERED_B = MANIFEST.occurrences[1]?.id ?? OFFERED_A;

/**
 * The head-side changed region of an offered hunk, as the model cites it: path, side and
 * a 1-based range, derived from the manifest so the fixture cannot drift from the offer.
 * Since path-line-citations this is the ONLY location vocabulary a noise turn is given —
 * the `rennet:hunk/<id>` anchor on the stored item is minted from exactly this.
 */
function cites(hunkId: string): {
  readonly path: string;
  readonly side: "head";
  readonly startLine: number;
  readonly endLine: number;
} {
  const occurrence = MANIFEST.occurrences.find((entry) => entry.id === hunkId);
  const span = occurrence?.spans?.new ?? { start: 1, lines: 1 };
  return {
    path: occurrence?.path ?? "",
    side: "head",
    startLine: span.start,
    endLine: span.start + span.lines - 1,
  };
}

const CAPABILITY: RspCapabilitySnapshot = {
  structuredOutput: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
  perCallModelSelection: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
};

const SEED: NoiseProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "2.1.220",
  adapterVersion: "0.1.0",
  model: "claude-opus-4-8",
  modelReportedBy: "harness",
  capability: CAPABILITY,
};

/**
 * The session-context writer stand-in: records what the runner wrote and answers with the
 * directory as a seat would name it. Reset per test through `writtenFiles`.
 */
const writtenFiles: NoiseContextFile[] = [];
const CONTEXT_DIR = ".rennet/context/session-1";
const writeContext = (files: readonly NoiseContextFile[]): string => {
  writtenFiles.splice(0, writtenFiles.length, ...files);
  return CONTEXT_DIR;
};

/** A mocked harness turn that emits the given body on attempt 0, then fails. */
function emits(body: unknown): (prompt: string, attempt: number) => Promise<NoiseTurnResult> {
  return (_prompt, attempt) =>
    Promise.resolve(
      attempt === 0
        ? { status: "emitted", body }
        : { status: "failed", message: "no scripted body" },
    );
}

/** A model group as the SDK would emit it (no groupId — the runner mints it). */
function ruleGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "lockfile",
    summary: "Dependency graph unchanged; the lockfile was regenerated.",
    judgedBy: { kind: "rule", rule: "lockfile" },
    items: [{ ...cites(OFFERED_A), detail: "pnpm-lock.yaml — hashes refreshed" }],
    ...overrides,
  };
}

/** A model group tagged noise-job (no model — the runner stamps it). */
function noiseJobGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "import-order",
    summary: "Imports reordered; no symbol added or removed.",
    judgedBy: { kind: "noise-job" },
    items: [{ ...cites(OFFERED_B), detail: "src/b.ts — imports sorted" }],
    ...overrides,
  };
}

describe("runNoiseAngle — the live noise runner (issue #34)", () => {
  // session-context-files 3.5: the offer is a FILE the prompt names, and so is the
  // assembled project context — copied into the session directory, never named at the
  // daemon's own store path, which a seat in another locus cannot open. Nothing rides inline.
  const captureSent = async (over: {
    readonly assembledContext?: string;
    readonly diffCommand?: string;
    readonly runTurn?: (prompt: string, attempt: number) => Promise<NoiseTurnResult>;
  }): Promise<string[]> => {
    const sent: string[] = [];
    await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      noiseJobModel: "Claude",
      ...(over.assembledContext === undefined ? {} : { assembledContext: over.assembledContext }),
      ...(over.diffCommand === undefined ? {} : { diffCommand: over.diffCommand }),
      runTurn: (prompt, attempt) => {
        sent.push(prompt);
        return over.runTurn === undefined
          ? Promise.resolve({ status: "emitted", body: { groups: [] } })
          : over.runTurn(prompt, attempt);
      },
      budget: createInvocationBudget(5),
    });
    return sent;
  };

  it("names the offer file, the diff command and the copied project context — and carries no payload", async () => {
    const assembled = "PROJECT_CONTEXT_BODY: the repo prefers tabs.";
    const prompt =
      (
        await captureSent({
          assembledContext: assembled,
          diffCommand: `git diff ${"0".repeat(40)}...${"1".repeat(40)}`,
        })
      )[0] ?? "";
    // The payload layer NAMES the offer; the context layer NAMES the persisted text.
    expect(prompt).toContain(
      `<<<rennet:layer payload>>>\nYour working directory is a checkout of the reviewed repository.\nThe changed regions you may cite are listed in \`${CONTEXT_DIR}/${NOISE_OFFER_FILE}\``,
    );
    expect(prompt).toContain(`<<<rennet:layer context>>>\nRennet's assembled project context`);
    // NAMED relative to the seat's cwd, and the TEXT is in the file, not the prompt.
    expect(prompt).toContain(`\`${CONTEXT_DIR}/${NOISE_PROJECT_CONTEXT_FILE}\``);
    expect(prompt).not.toContain(assembled);
    expect(writtenFiles.find((f) => f.name === NOISE_PROJECT_CONTEXT_FILE)?.body).toBe(assembled);
    expect(prompt).toContain(`git diff ${"0".repeat(40)}...${"1".repeat(40)}`);
    // No hunk id, no line body, no JSON over the inline bound.
    expect(prompt).not.toContain(OFFERED_A);
    expect(prompt).not.toContain("resolution: {integrity: sha512-xxx}");
    expect(inlineContextViolation(prompt)).toBeUndefined();
    // Under the two-kilobyte bound the spec sets on a reference layer, whatever the change:
    // everything after the base instruction is the two reference layers.
    const references = prompt.slice(prompt.indexOf("<<<rennet:layer context>>>"));
    expect(Buffer.byteLength(references, "utf8")).toBeLessThan(2_048);
  });

  it("writes noise-offer.json as path+side+line-range regions, with NO hunk id and NO line bodies", async () => {
    await captureSent({});
    const offer = writtenFiles.find((file) => file.name === NOISE_OFFER_FILE);
    expect(offer).toBeDefined();
    expect(offer?.holds).toMatch(/no line bodies/);
    const parsed = JSON.parse(offer?.body ?? "{}") as {
      patchsetId: string;
      regions: { path: string; side: string; startLine: number; endLine: number }[];
    };
    expect(parsed.patchsetId).toBe(PATCHSET.id);
    // One region per side a hunk actually changed. Every offered hunk here is a pure
    // addition (`@@ -1,0 +1,n @@`), so each offers its head side and no base side. The
    // lockfile is not in the list because the decomposition does not offer it as a hunk.
    expect(parsed.regions).toEqual([
      { path: "src/a.ts", side: "head", startLine: 1, endLine: 1 },
      { path: "src/b.ts", side: "head", startLine: 1, endLine: 2 },
    ]);
    // No id in the offer at all — path-line-citations: a hunk id is an internal key.
    for (const occurrence of MANIFEST.occurrences) {
      expect(offer?.body, `offer leaked ${occurrence.id}`).not.toContain(occurrence.id);
    }
    // The body is the offer without `sides`: no added, deleted or context line reaches it.
    expect(offer?.body).not.toContain("resolution: {integrity: sha512-xxx}");
    expect(offer?.body).not.toContain("export const a = 1;");
    expect(offer?.body).not.toContain('"sides"');
    // Positive control for BOTH absence claims: the manifest the runner holds carries the
    // ids and the line bodies, so "not in the offer" is a real difference.
    expect(JSON.stringify(MANIFEST)).toContain(OFFERED_A);
    expect(JSON.stringify(MANIFEST)).toContain("export const a = 1;");
  });

  it("mints the hunk anchor host-side from the region the model cited, and keeps the coordinates", async () => {
    // The whole of path-line-citations on this leg: the model is given coordinates and
    // gives coordinates back; the `rennet:hunk/<id>` the delta validator grounds is the
    // RUNNER's, resolved through the offered-region map. The coordinates stay on the
    // stored item because the model-facing body shape is what V108 re-checks on disk.
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: emits({ groups: [ruleGroup()] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    const item = result.groups[0]?.items[0];
    expect(item?.anchor).toBe(`rennet:hunk/${OFFERED_A}`);
    expect({
      path: item?.path,
      side: item?.side,
      startLine: item?.startLine,
      endLine: item?.endLine,
    }).toEqual(cites(OFFERED_A));
    // Control that the mint is a RESOLUTION and not a constant: the second fixture group
    // cites a different region and gets the other hunk's id.
    const other = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: emits({ groups: [noiseJobGroup()] }),
      budget: createInvocationBudget(5),
    });
    expect(other.groups[0]?.items[0]?.anchor).toBe(`rennet:hunk/${OFFERED_B}`);
    expect(OFFERED_B).not.toBe(OFFERED_A);
  });

  it("culls a citation that overruns its region rather than anchoring it to a hunk it exceeds", async () => {
    // `src/b.ts` offers head lines 1-2. A citation of 1-3 covers a line the change does
    // not have, so it grounds in nothing — dropped, never rounded down to the hunk.
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: emits({
        groups: [
          ruleGroup({
            items: [
              { ...cites(OFFERED_A), detail: "in range" },
              {
                path: "src/b.ts",
                side: "head",
                startLine: 1,
                endLine: 3,
                detail: "one line past the change",
              },
            ],
          }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups[0]?.items.map((i) => i.detail)).toEqual(["in range"]);
    // Control: the same citation one line shorter is exactly the offered region and survives.
    const inRange = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: emits({
        groups: [
          ruleGroup({
            items: [
              {
                path: "src/b.ts",
                side: "head",
                startLine: 1,
                endLine: 2,
                detail: "one line past the change",
              },
            ],
          }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(inRange.groups[0]?.items).toHaveLength(1);
  });

  it("re-asks the whole prompt after a transport failure, and the whole prompt is references only", async () => {
    // What this test used to claim it showed — a pointer-only repair — is not what the
    // noise angle does, and cannot be: this leg has no thread. Every attempt opens a fresh
    // `ephemeral: true` session (#585), so a follow-up that carried only pointers would
    // reach a session that has never seen the offer or the base instruction. The re-ask
    // legitimately re-sends everything.
    //
    // What makes that affordable is the SIZE, so the size is what is asserted. Before
    // session-context-files the payload layer WAS the offer — up to 256 KiB of hunk bodies
    // re-billed on every attempt. Now the whole prompt is the base instruction plus two
    // path references, so re-sending it costs a few kilobytes.
    const sent = await captureSent({
      runTurn: (_prompt, attempt) =>
        Promise.resolve(
          attempt === 0
            ? { status: "failed", message: "transport hiccup" }
            : { status: "emitted", body: { groups: [] } },
        ),
    });
    expect(sent).toHaveLength(2);
    const [first, retry] = sent as [string, string];
    // Identical: a transport failure produced no validator pointers to add, and there was
    // never a payload to drop, so the re-ask is byte-for-byte the first ask.
    expect(retry).toBe(first);
    // The whole re-billed prompt, bounded. The number is the CEILING this angle's re-ask
    // may cost, not a measurement to keep in step: it fails loudly if a payload comes
    // back, and the 4 KiB is roughly the base instruction plus the two reference layers.
    expect(Buffer.byteLength(retry, "utf8")).toBeLessThan(4_096);
    expect(retry).not.toContain(OFFERED_A);
    expect(retry).not.toContain("export const a = 1;");
    // Positive control for those two absence claims: the manifest the runner WAS handed
    // carries both the id and the line body, so "not in the prompt" is a real difference
    // between what the host holds and what it sends, not a string that exists nowhere.
    expect(JSON.stringify(MANIFEST)).toContain(OFFERED_A);
    expect(JSON.stringify(MANIFEST)).toContain("export const a = 1;");
    expect(inlineContextViolation(retry)).toBeUndefined();
  });

  it("without a persisted context path or a diff command the layer says `git diff` and names no text file", async () => {
    const prompt = (await captureSent({}))[0] ?? "";
    expect(prompt).toContain("`git diff` shows the whole change");
    expect(prompt).not.toContain("context-manifests");
    expect(prompt).not.toContain("<<<rennet:layer context>>>");
  });

  it("admits grounded groups, minting the id and stamping the noise-job model", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      noiseJobModel: "Claude",
      runTurn: emits({ groups: [ruleGroup(), noiseJobGroup()] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups).toHaveLength(2);

    const ruleG = result.groups.find((g) => g.category === "lockfile");
    expect(ruleG?.judgedBy).toEqual({ kind: "rule", rule: "lockfile" });
    // The runner mints identity — the model never supplied a groupId.
    expect(typeof ruleG?.groupId).toBe("string");
    expect((ruleG?.groupId ?? "").length).toBeGreaterThan(0);

    const jobG = result.groups.find((g) => g.category === "import-order");
    // The runner OWNS the chip's model label — stamped, never the model's to assert.
    expect(jobG?.judgedBy).toEqual({ kind: "noise-job", model: "Claude" });
    expect(result.document?.docType).toBe("noise");
  });

  it("defaults the noise-job model to the provenance model when not overridden", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: emits({ groups: [noiseJobGroup()] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups[0]?.judgedBy).toEqual({ kind: "noise-job", model: "claude-opus-4-8" });
  });

  it("culls an item whose anchor is not in the offered manifest (hallucinated)", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: emits({
        groups: [
          ruleGroup({
            items: [
              { ...cites(OFFERED_A), detail: "real hunk" },
              {
                path: "src/nowhere.ts",
                side: "head",
                startLine: 1,
                endLine: 1,
                detail: "hallucinated hunk",
              },
            ],
          }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.items).toHaveLength(1);
    expect(result.groups[0]?.items[0]?.detail).toBe("real hunk");
    expect(result.attempts[0]?.outcome).toBe("admitted");
  });

  it("drops a group left with no grounded items (nothing to collapse)", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: emits({
        groups: [
          ruleGroup(),
          ruleGroup({
            items: [
              { path: "src/ghost.ts", side: "head", startLine: 1, endLine: 1, detail: "gone" },
            ],
          }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups).toHaveLength(1);
    expect(result.attempts[0]?.culledCount).toBe(1);
  });

  it("drops a malformed group (bad category, empty summary, or junk judged-by)", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: emits({
        groups: [
          ruleGroup({ category: "not-a-category" }),
          ruleGroup({ summary: "   " }),
          ruleGroup({ judgedBy: { kind: "rule", rule: "" } }),
          ruleGroup({ judgedBy: { kind: "nonsense" } }),
          noiseJobGroup(), // the one good group
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.category).toBe("import-order");
    expect(result.attempts[0]?.culledCount).toBe(4);
  });

  it("preserves the deviating flag so the derivation can eject the line", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: emits({
        groups: [
          noiseJobGroup({
            items: [
              { ...cites(OFFERED_A), detail: "sorted alphabetically" },
              {
                ...cites(OFFERED_B),
                detail: "added a new import symbol",
                deviates: true,
              },
            ],
          }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    const items = result.groups[0]?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.deviates === true)?.detail).toBe("added a new import symbol");
  });

  it("culls an item whose detail smuggles a stray rennet: anchor", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: emits({
        groups: [
          ruleGroup({
            items: [
              { ...cites(OFFERED_A), detail: "clean detail" },
              { ...cites(OFFERED_B), detail: "rennet:hunk/smuggled in prose" },
            ],
          }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups[0]?.items).toHaveLength(1);
    expect(result.groups[0]?.items[0]?.detail).toBe("clean detail");
  });

  it("returns status ok with an empty set when the model groups nothing (ran clean)", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: emits({ groups: [] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups).toHaveLength(0);
    expect(result.budgetRefused).toBe(false);
  });

  // ── #158: a malformed body is not a clean review ─────────────────────────────
  // A model that returns a body which is not a noise document has NOT reviewed the
  // churn. Collapsing that to `{ groups: [] }` reports a clean review that grouped
  // nothing — indistinguishable from a genuine one. These two tests pin both
  // directions: a malformed body must FAIL, and a genuinely empty groups array
  // must still be OK. Emits the malformed body on EVERY attempt so the run resolves
  // to the terminal failed state (the original bug returned `ok` on attempt 0).

  it("treats a malformed body (not a noise document) as a failed turn, never a clean review (#158)", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: () =>
        Promise.resolve({
          status: "emitted",
          body: { result: "here is my prose review, nothing to group" },
        }),
      budget: createInvocationBudget(5),
    });
    // The bug's signature was `status: "ok"` with an empty groups set. The honest
    // outcome is the LOUD failed state — the model did not produce a noise document.
    expect(result.status).toBe("failed");
    expect(result.groups).toHaveLength(0);
    expect(result.report).toBeUndefined();
    expect(result.failureReason).toContain("malformed");
    // Recorded as its own fact, distinct from a turn that never emitted (turn-failed)
    // or an empty-but-valid review.
    expect(result.attempts.every((a) => a.outcome === "malformed-body")).toBe(true);
  });

  it.each([
    ["a bare string", "I reviewed the churn and it looks fine"],
    ["null", null],
    ["a bare array (the groups, un-wrapped)", []],
    ["an object whose groups is not an array", { groups: "none" }],
  ])("treats %s as malformed, not a clean review (#158)", async (_label, body) => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: () => Promise.resolve({ status: "emitted", body }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("failed");
    expect(result.groups).toHaveLength(0);
  });

  it("fails (not empty) when every turn fails — ran-clean is never faked from did-not-run", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: () => Promise.resolve({ status: "failed", message: "session died" }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("failed");
    expect(result.groups).toHaveLength(0);
    expect(result.failureReason).toBe("session died");
    expect(result.attempts.every((a) => a.outcome === "turn-failed")).toBe(true);
  });

  it("runs UNGATED when the budget is ABSENT — an absent budget is no ceiling, not no spend (#260)", async () => {
    let ran = false;
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: () => {
        ran = true;
        return Promise.resolve({ status: "emitted", body: { groups: [ruleGroup()] } });
      },
      // budget omitted — #260: no ceiling, the turn runs.
    });
    expect(ran).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.budgetRefused).toBe(false);
    expect(result.attempts[0]?.outcome).toBe("admitted");
  });

  it("refuses fail-closed on an exhausted (zero-ceiling) budget", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: emits({ groups: [ruleGroup()] }),
      budget: createInvocationBudget(0),
    });
    expect(result.status).toBe("failed");
    expect(result.budgetRefused).toBe(true);
  });

  it("retries after a turn failure and admits on a later successful turn", async () => {
    let attempts = 0;
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      writeContext,
      runTurn: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.resolve({ status: "failed", message: "first turn transport error" })
          : Promise.resolve({ status: "emitted", body: { groups: [ruleGroup()] } });
      },
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toBe("turn-failed");
    expect(result.attempts[1]?.outcome).toBe("admitted");
  });
});

// ── The offer file (session-context-files 3.5) ───────────────────────────────

describe("renderNoiseOffer", () => {
  // Forty 12-line hunks: the shape whose bodies used to need a 256 KiB bound. The offer
  // carries none of them, so there is no bound to test any more — only the absence.
  const BIG_MANIFEST = buildOfferedManifest(
    decompose({
      ...PATCHSET,
      files: Array.from({ length: 40 }, (_, i) =>
        file(
          `src/big-${i}.ts`,
          patch(
            `src/big-${i}.ts`,
            Array.from(
              { length: 12 },
              (_, line) => `+export const v${i}_${line} = "${"x".repeat(24)}";`,
            ),
          ),
        ),
      ),
    }),
  );
  const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

  it("is compact JSON: one region per changed side, in offered order, and NO ids", () => {
    const text = renderNoiseOffer(BIG_MANIFEST, "ps_big");
    expect(text).not.toContain("\n");
    const offered = BIG_MANIFEST.occurrences.filter((o) => o.kind === "hunk");
    const parsed = JSON.parse(text) as { regions: Record<string, unknown>[] };
    // Pure additions: one head-side region each, in the manifest's own order.
    expect(parsed.regions.map((r) => r.path)).toEqual(offered.map((o) => o.path));
    for (const region of parsed.regions)
      expect(Object.keys(region).sort()).toEqual(["endLine", "path", "side", "startLine"]);
    expect(text).not.toContain("x".repeat(24));
    for (const occurrence of offered) expect(text).not.toContain(occurrence.id);
    // Scale: ~65 bytes per region against ~677 with bodies — and it is a file, not a prompt.
    expect(bytes(text)).toBeLessThan(offered.length * 200);
    // Positive control for both absence claims: the whole manifest carries the bodies and
    // the ids, so the offer omitting them is a real difference.
    expect(JSON.stringify(BIG_MANIFEST)).toContain("x".repeat(24));
    expect(JSON.stringify(BIG_MANIFEST)).toContain(offered[0]?.id ?? "");
  });

  it("carries only hunk occurrences", () => {
    const withSymbol = {
      occurrences: [...MANIFEST.occurrences, { id: "sym-1", kind: "symbol" as const }],
    };
    const text = renderNoiseOffer(withSymbol, "ps_1");
    const parsed = JSON.parse(text) as { regions: { path: string }[] };
    // A symbol occurrence carries no path or spans, so it offers no region at all.
    expect(parsed.regions).toHaveLength(
      MANIFEST.occurrences.filter((o) => o.kind === "hunk").length,
    );
    expect(text).not.toContain("sym-1");
  });
});
