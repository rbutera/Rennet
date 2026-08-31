import type { SnapshotFileEntry } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { HarnessTurnResult } from "../harness-run-turn";
import { type LoadedSnapshot, materializeSnapshot } from "../project-context";
import { buildSnapshot, type SnapshotStructuralInputs } from "../project-snapshot";
import type { PartitionSlice } from "./partition";
import {
  MAP_SCOPE_GENERATOR_ID,
  MAP_SCOPE_OUTPUT_SCHEMA,
  MAP_SCOPE_SLICE_CAP,
  type MapScopeRunTurn,
  mapScopeCatalogueDigest,
  materializeKnowledgeCoverage,
  runMapScope,
} from "./scope";

const PROVENANCE = { model: "configured-model", apiKeySource: "configured-key" } as const;

function candidateAt(index: number): PartitionSlice {
  const ordinal = String(index).padStart(2, "0");
  const path = index === MAP_SCOPE_SLICE_CAP ? "docs/guide.md" : `src/f${ordinal}.ts`;
  return {
    id: index === MAP_SCOPE_SLICE_CAP ? "dir:docs" : `mod:${path}#${ordinal}`,
    files: [{ path, blobOid: `blob:${path}` }],
    neighbors: [],
    imports: [],
  };
}

const CANDIDATES = Array.from({ length: MAP_SCOPE_SLICE_CAP + 1 }, (_, index) =>
  candidateAt(index),
);

function loadedSnapshot(): LoadedSnapshot {
  const candidateFiles: SnapshotFileEntry[] = CANDIDATES.flatMap((candidate) =>
    candidate.files.map((file) => ({
      path: file.path,
      blobOid: file.blobOid,
      size: 1,
      mode: "100644",
    })),
  );
  const inputs = {
    repoKey: "/repo/.git",
    baseRef: "main",
    baseRefResolution: "symbolic-head",
    baseOid: "base-oid",
    files: [
      ...candidateFiles,
      { path: "pnpm-lock.yaml", blobOid: "blob:lock", size: 1, mode: "100644" },
    ],
    scopes: [],
    edges: [],
    entryPoints: [],
    tests: [],
    ownership: [],
    conventions: [],
  } satisfies SnapshotStructuralInputs;
  const built = buildSnapshot(inputs, []);
  const materialized = materializeSnapshot(built.manifest, (digest) => built.shards.get(digest));
  if (!materialized.ok) throw new Error(`materialize failed: ${materialized.slots.join(",")}`);
  return materialized.snapshot;
}

const SNAPSHOT = loadedSnapshot();

function acceptedBody(candidates: readonly PartitionSlice[] = CANDIDATES) {
  return {
    include: candidates.slice(0, MAP_SCOPE_SLICE_CAP).map((candidate) => candidate.id),
    exclude: candidates.slice(MAP_SCOPE_SLICE_CAP).map((candidate) => ({
      sliceId: candidate.id,
      reason: "lower mapping value",
    })),
  };
}

function emitted(body: unknown): HarnessTurnResult {
  return { status: "emitted", body };
}

function manifestFrom(prompt: string): unknown {
  const marker = "CLASSIFIED CANDIDATE MANIFEST:\n";
  const start = prompt.indexOf(marker);
  if (start < 0) throw new Error("candidate manifest marker missing");
  return JSON.parse(prompt.slice(start + marker.length));
}

describe("runMapScope", () => {
  it("includes up to 64 slices deterministically without spending a model turn", async () => {
    let calls = 0;
    const candidates = CANDIDATES.slice(0, MAP_SCOPE_SLICE_CAP);
    const result = await runMapScope({
      snapshot: SNAPSHOT,
      candidates,
      provenance: PROVENANCE,
      runTurn: async () => {
        calls += 1;
        return emitted(acceptedBody());
      },
    });

    expect(MAP_SCOPE_SLICE_CAP).toBe(64);
    expect(calls).toBe(0);
    expect(result).toEqual({
      status: "ok",
      includedSliceIds: candidates.map((candidate) => candidate.id),
      excludedSlices: [],
      provenance: { generator: MAP_SCOPE_GENERATOR_ID, ...PROVENANCE },
      attempts: 0,
    });
  });

  it("renders the exact classified whole-slice manifest above the cap", async () => {
    let prompt = "";
    const result = await runMapScope({
      snapshot: SNAPSHOT,
      candidates: CANDIDATES,
      provenance: PROVENANCE,
      runTurn: async (value) => {
        prompt = value;
        return emitted(acceptedBody());
      },
    });

    expect(result.status).toBe("ok");
    expect(prompt).toContain("Every offered slice ID must appear exactly once");
    expect(prompt).toContain("Decide only at whole-slice granularity");
    expect(prompt).toContain("Use the full 64-slice allowance");
    expect(prompt).toContain(
      "Tests, fixtures, documentation, tooling, and adapters are not automatically disposable",
    );
    expect(manifestFrom(prompt)).toEqual({
      selector: { generator: MAP_SCOPE_GENERATOR_ID, cap: MAP_SCOPE_SLICE_CAP },
      scopes: [],
      entryPoints: [],
      tests: [],
      candidates: CANDIDATES.map((candidate, index) => ({
        sliceId: candidate.id,
        kind: index < MAP_SCOPE_SLICE_CAP ? "module-batch" : "directory-fallback",
        families: [
          candidate.id.includes("#")
            ? candidate.id.slice(0, candidate.id.lastIndexOf("#"))
            : candidate.id,
        ],
        requiredEntryPointPaths: [],
        files: candidate.files.map((file) => ({ path: file.path, symbols: null })),
        imports: [],
        cuts: [],
      })).sort((left, right) => left.sliceId.localeCompare(right.sliceId)),
      mechanicallyIneligible: [{ path: "pnpm-lock.yaml", reason: "lockfile" }],
    });
  });

  it("canonicalizes accepted decisions in candidate order and reports observed provenance", async () => {
    const excluded = [CANDIDATES[10] as PartitionSlice, CANDIDATES[2] as PartitionSlice];
    const excludedIds = new Set(excluded.map((candidate) => candidate.id));
    const included = CANDIDATES.filter((candidate) => !excludedIds.has(candidate.id)).reverse();
    const result = await runMapScope({
      snapshot: SNAPSHOT,
      candidates: CANDIDATES,
      provenance: PROVENANCE,
      runTurn: async () => ({
        status: "emitted",
        body: {
          include: included.map((candidate) => candidate.id),
          exclude: [
            { sliceId: excluded[0]?.id, reason: "  generated surface  " },
            { sliceId: excluded[1]?.id, reason: "  low signal  " },
          ],
        },
        observed: { model: "actual-model", apiKeySource: "actual-key" },
      }),
    });

    expect(result).toEqual({
      status: "ok",
      includedSliceIds: CANDIDATES.filter((candidate) => !excludedIds.has(candidate.id)).map(
        (candidate) => candidate.id,
      ),
      excludedSlices: [
        { sliceId: CANDIDATES[2]?.id, reason: "low signal" },
        { sliceId: CANDIDATES[10]?.id, reason: "generated surface" },
      ],
      provenance: {
        generator: MAP_SCOPE_GENERATOR_ID,
        model: "actual-model",
        apiKeySource: "actual-key",
      },
      attempts: 1,
    });
  });

  const valid = acceptedBody();
  const invalidBodies: ReadonlyArray<readonly [string, unknown]> = [
    ["unknown include id", { ...valid, include: ["mod:unknown#id", ...valid.include.slice(1)] }],
    [
      "duplicate include id",
      { ...valid, include: [valid.include[0], valid.include[0], ...valid.include.slice(2)] },
    ],
    ["duplicate exclude id", { ...valid, exclude: [valid.exclude[0], valid.exclude[0]] }],
    [
      "include/exclude overlap",
      {
        include: [valid.exclude[0]?.sliceId, ...valid.include.slice(1)],
        exclude: valid.exclude,
      },
    ],
    [
      "blank exclusion reason",
      { ...valid, exclude: [{ sliceId: valid.exclude[0]?.sliceId, reason: "   " }] },
    ],
    [
      "unknown exclusion id",
      { ...valid, exclude: [{ sliceId: "dir:unknown", reason: "not useful" }] },
    ],
    ["omitted candidate", { ...valid, include: valid.include.slice(1) }],
    [
      "all candidates excluded",
      {
        include: [],
        exclude: CANDIDATES.map((candidate) => ({
          sliceId: candidate.id,
          reason: "not selected",
        })),
      },
    ],
    [
      "more than 64 included",
      { include: CANDIDATES.map((candidate) => candidate.id), exclude: [] },
    ],
    ["additional property", { ...valid, note: "not part of the contract" }],
  ];

  it.each(invalidBodies)("rejects %s, then accepts one valid retry", async (_label, invalid) => {
    const attempts: number[] = [];
    const result = await runMapScope({
      snapshot: SNAPSHOT,
      candidates: CANDIDATES,
      provenance: PROVENANCE,
      runTurn: async (_prompt, attempt) => {
        attempts.push(attempt);
        return emitted(attempt === 0 ? invalid : valid);
      },
    });

    expect(attempts).toEqual([0, 1]);
    expect(result).toMatchObject({ status: "ok", attempts: 2 });
  });

  it("retries a returned turn failure before accepting a valid partition", async () => {
    const result = await runMapScope({
      snapshot: SNAPSHOT,
      candidates: CANDIDATES,
      provenance: PROVENANCE,
      runTurn: async (_prompt, attempt) =>
        attempt === 0 ? { status: "failed", message: "transport failed" } : emitted(valid),
    });

    expect(result).toMatchObject({ status: "ok", attempts: 2 });
  });

  it("returns a typed failure after the second invalid partition", async () => {
    const bodies = [
      { ...valid, include: ["mod:unknown#id", ...valid.include.slice(1)] },
      { ...valid, exclude: [{ sliceId: valid.exclude[0]?.sliceId, reason: " " }] },
    ];
    const runTurn: MapScopeRunTurn = async (_prompt, attempt) => ({
      status: "emitted",
      body: bodies[attempt],
      observed: { model: `actual-model-${attempt}`, apiKeySource: `actual-key-${attempt}` },
    });
    const result = await runMapScope({
      snapshot: SNAPSHOT,
      candidates: CANDIDATES,
      provenance: PROVENANCE,
      runTurn,
    });

    expect(result).toEqual({
      status: "failed",
      failureReason: "exclude[0].reason must be a nonblank string",
      provenance: {
        generator: MAP_SCOPE_GENERATOR_ID,
        model: "actual-model-1",
        apiKeySource: "actual-key-1",
      },
      attempts: 2,
    });
  });

  it("requires a slice containing an explicit entry point, then accepts it on retry", async () => {
    const snapshot: LoadedSnapshot = {
      ...SNAPSHOT,
      scopes: [{ name: "app", root: "", private: true, tags: [] }],
      entryPoints: [{ scope: "app", main: "./src/f00.ts", exports: "./ignored.ts", bin: [] }],
    };
    const required = CANDIDATES[0] as PartitionSlice;
    const validWithRequired = acceptedBody();
    const invalid = {
      include: CANDIDATES.slice(1).map((candidate) => candidate.id),
      exclude: [{ sliceId: required.id, reason: "low signal" }],
    };
    const prompts: string[] = [];
    const result = await runMapScope({
      snapshot,
      candidates: CANDIDATES,
      provenance: PROVENANCE,
      runTurn: async (prompt, attempt) => {
        prompts.push(prompt);
        return emitted(attempt === 0 ? invalid : validWithRequired);
      },
    });

    expect(result).toMatchObject({ status: "ok", attempts: 2 });
    const catalogue = manifestFrom(prompts[0] as string) as {
      candidates: readonly { sliceId: string; requiredEntryPointPaths: readonly string[] }[];
    };
    expect(
      catalogue.candidates.find((candidate) => candidate.sliceId === required.id),
    ).toMatchObject({
      requiredEntryPointPaths: ["src/f00.ts"],
    });
  });

  it("treats nested package exports as explicit entry points", async () => {
    const required = CANDIDATES[1] as PartitionSlice;
    const requiredPath = required.files[0]?.path;
    if (requiredPath === undefined) throw new Error("export-entry fixture has no file");
    const snapshot: LoadedSnapshot = {
      ...SNAPSHOT,
      scopes: [{ name: "app", root: "", private: true, tags: [] }],
      entryPoints: [
        {
          scope: "app",
          exports: { ".": { import: `./${requiredPath}` } },
          bin: [],
        },
      ],
    };
    const invalidIncluded = CANDIDATES.filter((candidate) => candidate.id !== required.id);
    const prompts: string[] = [];
    const result = await runMapScope({
      snapshot,
      candidates: CANDIDATES,
      provenance: PROVENANCE,
      runTurn: async (prompt, attempt) => {
        prompts.push(prompt);
        return emitted(
          attempt === 0
            ? {
                include: invalidIncluded.map((candidate) => candidate.id),
                exclude: [{ sliceId: required.id, reason: "low signal" }],
              }
            : acceptedBody(),
        );
      },
    });

    expect(result).toMatchObject({ status: "ok", attempts: 2 });
    const catalogue = manifestFrom(prompts[0] as string) as {
      candidates: readonly { sliceId: string; requiredEntryPointPaths: readonly string[] }[];
    };
    expect(
      catalogue.candidates.find((candidate) => candidate.sliceId === required.id),
    ).toMatchObject({ requiredEntryPointPaths: [requiredPath] });
  });

  it("fails before a turn when explicit entry points require more than 64 slices", async () => {
    const snapshot: LoadedSnapshot = {
      ...SNAPSHOT,
      scopes: [{ name: "app", root: "", private: true, tags: [] }],
      entryPoints: [
        {
          scope: "app",
          bin: CANDIDATES.map((candidate, index) => [
            `entry-${index}`,
            candidate.files[0]?.path as string,
          ]),
        },
      ],
    };
    let calls = 0;
    const result = await runMapScope({
      snapshot,
      candidates: CANDIDATES,
      provenance: PROVENANCE,
      runTurn: async () => {
        calls += 1;
        return emitted(acceptedBody());
      },
    });

    expect(calls).toBe(0);
    expect(result).toEqual({
      status: "failed",
      failureReason: "65 entry-point slices exceed the 64-slice cap",
      provenance: { generator: MAP_SCOPE_GENERATOR_ID, ...PROVENANCE },
      attempts: 0,
    });
  });
});

describe("mapScopeCatalogueDigest", () => {
  it("is stable across base/blob identity changes but changes with rendered body facts", () => {
    const baseline = mapScopeCatalogueDigest(SNAPSHOT, CANDIDATES);
    const rebasedSnapshot: LoadedSnapshot = {
      ...SNAPSHOT,
      manifest: { ...SNAPSHOT.manifest, baseOid: "different-base" },
      files: SNAPSHOT.files.map((file) => ({ ...file, blobOid: `rebased:${file.path}` })),
    };
    const rebasedCandidates = CANDIDATES.map((candidate) => ({
      ...candidate,
      files: candidate.files.map((file) => ({ ...file, blobOid: `rebased:${file.path}` })),
    }));
    expect(mapScopeCatalogueDigest(rebasedSnapshot, rebasedCandidates)).toBe(baseline);

    const contextualSnapshot: LoadedSnapshot = {
      ...SNAPSHOT,
      scopes: [{ name: "app", root: "src", private: true, tags: ["runtime"] }],
      entryPoints: [{ scope: "app", main: "./f00.ts", bin: [] }],
      tests: [{ path: "src/f01.ts", scope: "app", matchedBy: "src/**/*.ts" }],
    };
    expect(mapScopeCatalogueDigest(contextualSnapshot, CANDIDATES)).not.toBe(baseline);

    const structuralCandidates = CANDIDATES.map((candidate, index) =>
      index === 0
        ? {
            ...candidate,
            families: ["family:a", "family:b"],
            files: candidate.files.map((file) => ({
              ...file,
              symbols: [{ name: "main", kind: "function" as const, line: 1 }],
            })),
            imports: [{ from: candidate.files[0]?.path as string, to: "src/f01.ts" }],
            neighbors: [
              {
                path: candidate.files[0]?.path as string,
                neighbors: [
                  {
                    path: "src/f01.ts",
                    direction: "imports" as const,
                    symbols: ["helper"],
                  },
                ],
                truncated: 0,
              },
            ],
          }
        : candidate,
    );
    expect(mapScopeCatalogueDigest(SNAPSHOT, structuralCandidates)).not.toBe(baseline);
    expect(baseline).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("materializeKnowledgeCoverage", () => {
  it("joins trusted slice membership and mechanical exclusions into one exact inventory partition", async () => {
    const selection = await runMapScope({
      snapshot: SNAPSHOT,
      candidates: CANDIDATES,
      provenance: PROVENANCE,
      runTurn: async () => emitted(acceptedBody()),
    });
    if (selection.status !== "ok") throw new Error(selection.failureReason);
    const coverage = materializeKnowledgeCoverage({
      snapshot: SNAPSHOT,
      candidates: CANDIDATES,
      selection,
      selector: {
        kind: "council",
        harness: "codex",
        assignedModel: "configured-model",
        model: "configured-model",
        effort: "medium",
        apiKeySource: "configured-key",
      },
    });

    expect(coverage.catalogueDigest).toBe(mapScopeCatalogueDigest(SNAPSHOT, CANDIDATES));
    expect(coverage.selector).toEqual({
      kind: "council",
      cap: 64,
      generator: MAP_SCOPE_GENERATOR_ID,
      harness: "codex",
      assignedModel: "configured-model",
      model: "configured-model",
      effort: "medium",
      apiKeySource: "configured-key",
    });
    expect(coverage.groups.find((group) => group.kind === "mapped")).toMatchObject({
      kind: "mapped",
      sliceId: CANDIDATES[0]?.id,
      files: CANDIDATES[0]?.files.map(({ path, blobOid }) => ({ path, blobOid })),
    });
    expect(
      coverage.groups.find((group) => group.kind === "excluded" && group.source === "scope"),
    ).toEqual({
      kind: "excluded",
      source: "scope",
      sliceId: "dir:docs",
      reason: "lower mapping value",
      files: [{ path: "docs/guide.md", blobOid: "blob:docs/guide.md" }],
    });
    expect(
      coverage.groups.find((group) => group.kind === "excluded" && group.source === "mechanical"),
    ).toEqual({
      kind: "excluded",
      source: "mechanical",
      reason: "lockfile",
      files: [{ path: "pnpm-lock.yaml", blobOid: "blob:lock" }],
    });
    const coveredPaths = coverage.groups.flatMap((group) => group.files.map((file) => file.path));
    expect(new Set(coveredPaths).size).toBe(coveredPaths.length);
    expect([...coveredPaths].sort()).toEqual(SNAPSHOT.files.map((file) => file.path).sort());
  });

  it("refuses coverage when trusted slice membership does not cover the exact inventory", async () => {
    const selection = await runMapScope({
      snapshot: SNAPSHOT,
      candidates: CANDIDATES,
      provenance: PROVENANCE,
      runTurn: async () => emitted(acceptedBody()),
    });
    if (selection.status !== "ok") throw new Error(selection.failureReason);
    const brokenCandidates = CANDIDATES.map((candidate, index) =>
      index === 0 ? { ...candidate, files: [] } : candidate,
    );

    expect(() =>
      materializeKnowledgeCoverage({
        snapshot: SNAPSHOT,
        candidates: brokenCandidates,
        selection,
        selector: {
          kind: "council",
          harness: "codex",
          assignedModel: "configured-model",
          model: "configured-model",
          effort: "medium",
          apiKeySource: "configured-key",
        },
      }),
    ).toThrow(`candidate slice ${CANDIDATES[0]?.id} has no files`);
  });

  it("refuses a persisted decision that excludes an entry-point slice", () => {
    const required = CANDIDATES[0] as PartitionSlice;
    const requiredPath = required.files[0]?.path;
    if (requiredPath === undefined) throw new Error("entry-point fixture has no file");
    const snapshot: LoadedSnapshot = {
      ...SNAPSHOT,
      scopes: [{ name: "app", root: "", private: true, tags: [] }],
      entryPoints: [{ scope: "app", exports: { ".": `./${requiredPath}` }, bin: [] }],
    };

    expect(() =>
      materializeKnowledgeCoverage({
        snapshot,
        candidates: CANDIDATES,
        selection: {
          status: "ok",
          includedSliceIds: CANDIDATES.slice(1).map((candidate) => candidate.id),
          excludedSlices: [{ sliceId: required.id, reason: "low signal" }],
          provenance: { generator: MAP_SCOPE_GENERATOR_ID, ...PROVENANCE },
          attempts: 1,
        },
        selector: {
          kind: "council",
          harness: "codex",
          assignedModel: "configured-model",
          model: "configured-model",
          effort: "medium",
          apiKeySource: "configured-key",
        },
      }),
    ).toThrow(`entry-point slice ${required.id} must be mapped`);
  });

  it("refuses persisted selector modes that contradict the candidate cap", () => {
    const belowCapCandidates = CANDIDATES.slice(0, MAP_SCOPE_SLICE_CAP);
    const belowCapSelection = {
      status: "ok" as const,
      includedSliceIds: belowCapCandidates.map((candidate) => candidate.id),
      excludedSlices: [],
      provenance: { generator: MAP_SCOPE_GENERATOR_ID, ...PROVENANCE },
      attempts: 0,
    };
    expect(() =>
      materializeKnowledgeCoverage({
        snapshot: SNAPSHOT,
        candidates: belowCapCandidates,
        selection: belowCapSelection,
        selector: {
          kind: "council",
          harness: "codex",
          assignedModel: "configured-model",
          model: "configured-model",
          effort: "medium",
          apiKeySource: "configured-key",
        },
      }),
    ).toThrow("at-or-below-cap coverage must deterministically map every candidate slice");

    expect(() =>
      materializeKnowledgeCoverage({
        snapshot: SNAPSHOT,
        candidates: CANDIDATES,
        selection: {
          ...belowCapSelection,
          excludedSlices: [{ sliceId: CANDIDATES[MAP_SCOPE_SLICE_CAP]?.id as string, reason: "x" }],
        },
        selector: { kind: "below-cap" },
      }),
    ).toThrow("above-cap coverage must use the council selector and map 1..64 slices");
  });
});

describe("MAP_SCOPE_OUTPUT_SCHEMA", () => {
  it("expresses the strict exhaustive-partition envelope", () => {
    expect(MAP_SCOPE_OUTPUT_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["include", "exclude"],
      properties: {
        include: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          items: { type: "string" },
        },
        exclude: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["sliceId", "reason"],
            properties: {
              sliceId: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
      },
    });
  });
});
