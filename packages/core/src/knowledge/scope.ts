import type {
  CouncilEffort,
  KnowledgeCoverage,
  KnowledgeCoverageFile,
  KnowledgeCoverageGroup,
  KnowledgeMechanicalExclusionReason,
} from "@rennet/protocol";
import { canonicalize, sha256Hex } from "@rennet/protocol";
import { classifyInventory, type InventoryClassification } from "../file-classification";
import type { HarnessTurnResult } from "../harness-run-turn";
import { type LoadedSnapshot, querySymbolIndex } from "../project-context";
import type { KnowledgeProvenanceSeed } from "./mint";
import { type PartitionSlice, sliceFamilies } from "./partition";

export const MAP_SCOPE_SLICE_CAP = 64;
export const MAP_SCOPE_GENERATOR_ID = "map-scope@1" as const;
const MAP_SCOPE_BOUNDARY_PATH_CAP = 24;

export const MAP_SCOPE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["include", "exclude"],
  properties: {
    include: {
      type: "array",
      minItems: 1,
      maxItems: MAP_SCOPE_SLICE_CAP,
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
} as const;

export type MapScopeRunTurn = (prompt: string, attempt: number) => Promise<HarnessTurnResult>;

export interface MapScopeExclusion {
  readonly sliceId: string;
  readonly reason: string;
}

export interface MapScopeProvenance {
  readonly generator: typeof MAP_SCOPE_GENERATOR_ID;
  readonly model: string | null;
  readonly apiKeySource: string | null;
}

export interface MapScopeSuccess {
  readonly status: "ok";
  readonly includedSliceIds: readonly string[];
  readonly excludedSlices: readonly MapScopeExclusion[];
  readonly provenance: MapScopeProvenance;
  readonly attempts: number;
}

export interface MapScopeFailure {
  readonly status: "failed";
  readonly failureReason: string;
  readonly provenance: MapScopeProvenance;
  readonly attempts: number;
}

export type MapScopeResult = MapScopeSuccess | MapScopeFailure;

export interface MapScopeInput {
  readonly snapshot: LoadedSnapshot;
  readonly candidates: readonly PartitionSlice[];
  readonly provenance: KnowledgeProvenanceSeed;
  readonly runTurn: MapScopeRunTurn;
}

export type MapScopeSelectorProvenance =
  | { readonly kind: "below-cap" }
  | {
      readonly kind: "council";
      readonly harness: "claude-code" | "codex";
      readonly assignedModel: string;
      readonly model: string;
      readonly effort: CouncilEffort;
      readonly apiKeySource: string | null;
    };

export interface MaterializeKnowledgeCoverageInput {
  readonly snapshot: LoadedSnapshot;
  readonly candidates: readonly PartitionSlice[];
  readonly selection: MapScopeSuccess;
  readonly selector: MapScopeSelectorProvenance;
}

interface MapScopeCatalogueCandidate {
  readonly sliceId: string;
  readonly kind: "module-batch" | "directory-fallback";
  readonly families: readonly string[];
  readonly requiredEntryPointPaths: readonly string[];
  readonly files: readonly {
    readonly path: string;
    readonly symbols:
      | readonly { readonly name: string; readonly kind: string; readonly line: number }[]
      | null;
  }[];
  readonly imports: readonly { readonly from: string; readonly to: string }[] | null;
  readonly cuts: readonly {
    readonly path: string;
    readonly neighbors: readonly {
      readonly path: string;
      readonly direction: "imports" | "imported-by" | "both";
      readonly symbols: readonly string[];
    }[];
    readonly truncated: number;
  }[];
}

interface MapScopeCatalogue {
  readonly selector: {
    readonly generator: typeof MAP_SCOPE_GENERATOR_ID;
    readonly cap: typeof MAP_SCOPE_SLICE_CAP;
  };
  readonly scopes: readonly unknown[];
  readonly entryPoints: readonly unknown[];
  readonly tests: readonly {
    readonly path: string;
    readonly scope: string | null;
    readonly matchedBy: string;
  }[];
  readonly candidates: readonly MapScopeCatalogueCandidate[];
  readonly mechanicallyIneligible: readonly {
    readonly path: string;
    readonly reason: KnowledgeMechanicalExclusionReason;
  }[];
}

interface MapScopeCatalogueFacts {
  readonly catalogue: MapScopeCatalogue;
  readonly classified: readonly InventoryClassification[];
  readonly requiredSliceIds: ReadonlySet<string>;
}

interface ValidatedSelection {
  readonly include: ReadonlySet<string>;
  readonly exclude: ReadonlyMap<string, string>;
}

type SelectionValidation =
  | { readonly ok: true; readonly selection: ValidatedSelection }
  | { readonly ok: false; readonly reason: string };

const MECHANICAL_REASONS: readonly KnowledgeMechanicalExclusionReason[] = [
  "binary",
  "lockfile",
  "vendored",
  "generated-path",
  "generated-content",
];

function byString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function provenanceFrom(
  seed: KnowledgeProvenanceSeed,
  observed?: { readonly model: string | null; readonly apiKeySource: string | null },
): MapScopeProvenance {
  return {
    generator: MAP_SCOPE_GENERATOR_ID,
    model: observed?.model ?? seed.model,
    apiKeySource: observed?.apiKeySource ?? seed.apiKeySource,
  };
}

function classifiedInventory(snapshot: LoadedSnapshot): readonly InventoryClassification[] {
  const symbols = querySymbolIndex(snapshot);
  return classifyInventory(
    snapshot.files,
    symbols.ok ? symbols.index.generatedBlobs : new Set<string>(),
  );
}

function exportedEntryPointPaths(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportedEntryPointPaths);
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportedEntryPointPaths);
}

function explicitEntryPointPaths(snapshot: LoadedSnapshot): ReadonlySet<string> {
  const rootsByScope = new Map<string, string[]>();
  for (const scope of snapshot.scopes) {
    const roots = rootsByScope.get(scope.name);
    if (roots === undefined) rootsByScope.set(scope.name, [scope.root]);
    else roots.push(scope.root);
  }

  const inventoryPaths = new Set(snapshot.files.map((file) => file.path));
  const paths = new Set<string>();
  for (const entryPoint of snapshot.entryPoints) {
    const values = [
      entryPoint.main,
      entryPoint.module,
      entryPoint.types,
      ...exportedEntryPointPaths(entryPoint.exports),
      ...entryPoint.bin.map(([, path]) => path),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const value of values) {
      const relative = value.startsWith("./") ? value.slice(2) : value;
      if (inventoryPaths.has(relative)) paths.add(relative);
      for (const root of rootsByScope.get(entryPoint.scope) ?? []) {
        const joined = root.length === 0 ? relative : `${root}/${relative}`;
        if (inventoryPaths.has(joined)) paths.add(joined);
      }
    }
  }
  return paths;
}

function requiredEntryPointsBySlice(
  snapshot: LoadedSnapshot,
  candidates: readonly PartitionSlice[],
): {
  readonly pathsBySlice: ReadonlyMap<string, readonly string[]>;
  readonly requiredSliceIds: ReadonlySet<string>;
} {
  const entryPointPaths = explicitEntryPointPaths(snapshot);
  const pathsBySlice = new Map<string, readonly string[]>();
  const requiredSliceIds = new Set<string>();
  for (const candidate of candidates) {
    const paths = candidate.files
      .map((file) => file.path)
      .filter((path) => entryPointPaths.has(path))
      .sort(byString);
    pathsBySlice.set(candidate.id, paths);
    if (paths.length > 0) requiredSliceIds.add(candidate.id);
  }
  return { pathsBySlice, requiredSliceIds };
}

function catalogueCandidate(
  slice: PartitionSlice,
  requiredEntryPointPaths: readonly string[],
): MapScopeCatalogueCandidate {
  return {
    sliceId: slice.id,
    kind: slice.id.startsWith("mod:") ? "module-batch" : "directory-fallback",
    families: [...new Set(sliceFamilies(slice))].sort(byString),
    requiredEntryPointPaths,
    files: slice.files
      .map((file) => ({
        path: file.path,
        symbols:
          file.symbols === undefined
            ? null
            : [...file.symbols]
                .map((symbol) => ({ name: symbol.name, kind: symbol.kind, line: symbol.line }))
                .sort(
                  (left, right) =>
                    byString(left.name, right.name) ||
                    byString(left.kind, right.kind) ||
                    left.line - right.line,
                ),
      }))
      .sort((left, right) => byString(left.path, right.path)),
    imports:
      slice.imports === undefined
        ? null
        : [...slice.imports].sort(
            (left, right) => byString(left.from, right.from) || byString(left.to, right.to),
          ),
    cuts: [...slice.neighbors]
      .map((member) => ({
        path: member.path,
        neighbors: [...member.neighbors]
          .map((neighbor) => ({
            path: neighbor.path,
            direction: neighbor.direction,
            symbols: [...new Set(neighbor.symbols)].sort(byString),
          }))
          .sort(
            (left, right) =>
              byString(left.path, right.path) || byString(left.direction, right.direction),
          ),
        truncated: member.truncated,
      }))
      .sort((left, right) => byString(left.path, right.path)),
  };
}

function mapScopeCatalogueFacts(
  snapshot: LoadedSnapshot,
  candidates: readonly PartitionSlice[],
): MapScopeCatalogueFacts {
  const classified = classifiedInventory(snapshot);
  const required = requiredEntryPointsBySlice(snapshot, candidates);
  const scopes = [...snapshot.scopes]
    .map((scope) => ({
      name: scope.name,
      root: scope.root,
      sourceRoot: scope.sourceRoot ?? null,
      type: scope.type ?? null,
      private: scope.private,
      tags: [...scope.tags].sort(byString),
    }))
    .sort(
      (left, right) =>
        byString(left.root, right.root) ||
        byString(left.name, right.name) ||
        byString(canonicalize(left), canonicalize(right)),
    );
  const entryPoints = [...snapshot.entryPoints]
    .map((entryPoint) => ({
      scope: entryPoint.scope,
      main: entryPoint.main ?? null,
      module: entryPoint.module ?? null,
      types: entryPoint.types ?? null,
      exports: entryPoint.exports ?? null,
      bin: [...entryPoint.bin].sort((left, right) => byString(left[0], right[0])),
    }))
    .sort(
      (left, right) =>
        byString(left.scope, right.scope) || byString(canonicalize(left), canonicalize(right)),
    );
  const tests = [...snapshot.tests]
    .map((test) => ({ path: test.path, scope: test.scope, matchedBy: test.matchedBy }))
    .sort(
      (left, right) =>
        byString(left.path, right.path) ||
        byString(left.scope ?? "", right.scope ?? "") ||
        byString(left.matchedBy, right.matchedBy),
    );
  const catalogue: MapScopeCatalogue = {
    selector: { generator: MAP_SCOPE_GENERATOR_ID, cap: MAP_SCOPE_SLICE_CAP },
    scopes,
    entryPoints,
    tests,
    candidates: [...candidates]
      .map((candidate) =>
        catalogueCandidate(candidate, required.pathsBySlice.get(candidate.id) ?? []),
      )
      .sort((left, right) => byString(left.sliceId, right.sliceId)),
    mechanicallyIneligible: classified.flatMap((entry) =>
      entry.ineligible === null
        ? []
        : [{ path: entry.path, reason: entry.ineligible as KnowledgeMechanicalExclusionReason }],
    ),
  };
  return { catalogue, classified, requiredSliceIds: required.requiredSliceIds };
}

function catalogueDigest(catalogue: MapScopeCatalogue): string {
  return `sha256:${sha256Hex(canonicalize(catalogue))}`;
}

export function mapScopeCatalogueDigest(
  snapshot: LoadedSnapshot,
  candidates: readonly PartitionSlice[],
): string {
  return catalogueDigest(mapScopeCatalogueFacts(snapshot, candidates).catalogue);
}

function selectorCatalogue(catalogue: MapScopeCatalogue) {
  const testPaths = new Set(catalogue.tests.map((test) => test.path));
  return {
    selector: catalogue.selector,
    scopes: catalogue.scopes,
    entryPoints: catalogue.entryPoints,
    candidates: catalogue.candidates.map((candidate) => {
      const boundaryPaths = [
        ...new Set(
          candidate.cuts.flatMap((member) => member.neighbors.map((neighbor) => neighbor.path)),
        ),
      ].sort(byString);
      return {
        sliceId: candidate.sliceId,
        kind: candidate.kind,
        families: candidate.families,
        requiredEntryPointPaths: candidate.requiredEntryPointPaths,
        files: candidate.files.map((file) => file.path),
        testFiles: candidate.files.map((file) => file.path).filter((path) => testPaths.has(path)),
        signals: {
          indexedFiles: candidate.files.filter((file) => file.symbols !== null).length,
          declaredSymbols: candidate.files.reduce(
            (count, file) => count + (file.symbols?.length ?? 0),
            0,
          ),
          internalImports: candidate.imports?.length ?? null,
          boundaryMembers: candidate.cuts.length,
          boundaryNeighbors: candidate.cuts.reduce(
            (count, member) => count + member.neighbors.length,
            0,
          ),
          truncatedBoundaryNeighbors: candidate.cuts.reduce(
            (count, member) => count + member.truncated,
            0,
          ),
          boundaryPathCount: boundaryPaths.length,
          boundaryPaths: boundaryPaths.slice(0, MAP_SCOPE_BOUNDARY_PATH_CAP),
          omittedBoundaryPaths: Math.max(0, boundaryPaths.length - MAP_SCOPE_BOUNDARY_PATH_CAP),
        },
      };
    }),
    mechanicallyIneligible: MECHANICAL_REASONS.flatMap((reason) => {
      const files = catalogue.mechanicallyIneligible.filter(
        (entry) => entry.reason === reason,
      ).length;
      return files === 0 ? [] : [{ reason, files }];
    }),
  };
}

function buildPrompt(catalogue: MapScopeCatalogue): string {
  return `Select the whole repository slices that receive mapping workers.

Return exactly {"include": string[], "exclude": {"sliceId": string, "reason": string}[]}.
Every offered slice ID must appear exactly once across include and exclude. Omission is invalid.
Decide only at whole-slice granularity: copy IDs exactly and never name individual files.
Include at least one and at most ${MAP_SCOPE_SLICE_CAP} slices. Exclusion reasons must be specific and nonblank.
Any candidate with requiredEntryPointPaths must be included. Mechanically ineligible file counts are already excluded and are informational only.
Prioritize runtime behavior, architecture, persistence, public contracts, entry points, and slices with distinct explanatory roles.
Use the full ${MAP_SCOPE_SLICE_CAP}-slice allowance when that many candidates have distinct explanatory value.
Tests, fixtures, documentation, tooling, and adapters are not automatically disposable; include them when they explain behavior or contracts.
Exclusion means only that the slice gets no worker turn in this generation, not that it is unimportant or absent from the repository.
You may inspect the repository checkout when the manifest is insufficient to make a grounded whole-slice decision.

CLASSIFIED CANDIDATE MANIFEST:
${canonicalize(selectorCatalogue(catalogue))}`;
}

function validateSelection(
  body: unknown,
  candidates: readonly PartitionSlice[],
  requiredSliceIds: ReadonlySet<string>,
): SelectionValidation {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "output must be an object" };
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "exclude,include") {
    return { ok: false, reason: "output must contain exactly include and exclude" };
  }
  if (!Array.isArray(record.include)) {
    return { ok: false, reason: "include must be an array" };
  }
  if (!Array.isArray(record.exclude)) {
    return { ok: false, reason: "exclude must be an array" };
  }
  if (record.include.length === 0) {
    return { ok: false, reason: "include must contain at least one slice" };
  }
  if (record.include.length > MAP_SCOPE_SLICE_CAP) {
    return {
      ok: false,
      reason: `include must contain at most ${MAP_SCOPE_SLICE_CAP} slices`,
    };
  }

  const offeredIds = new Set(candidates.map((candidate) => candidate.id));
  const include = new Set<string>();
  for (let index = 0; index < record.include.length; index += 1) {
    const sliceId = record.include[index];
    if (typeof sliceId !== "string") {
      return { ok: false, reason: `include[${index}] must be a string` };
    }
    if (!offeredIds.has(sliceId)) {
      return { ok: false, reason: `include[${index}] names unknown slice ${sliceId}` };
    }
    if (include.has(sliceId)) {
      return { ok: false, reason: `slice ${sliceId} appears more than once` };
    }
    include.add(sliceId);
  }

  const exclude = new Map<string, string>();
  for (let index = 0; index < record.exclude.length; index += 1) {
    const entry = record.exclude[index];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: `exclude[${index}] must be an object` };
    }
    const exclusion = entry as Record<string, unknown>;
    if (Object.keys(exclusion).sort().join(",") !== "reason,sliceId") {
      return {
        ok: false,
        reason: `exclude[${index}] must contain exactly sliceId and reason`,
      };
    }
    if (typeof exclusion.sliceId !== "string") {
      return { ok: false, reason: `exclude[${index}].sliceId must be a string` };
    }
    if (typeof exclusion.reason !== "string" || exclusion.reason.trim().length === 0) {
      return { ok: false, reason: `exclude[${index}].reason must be a nonblank string` };
    }
    if (!offeredIds.has(exclusion.sliceId)) {
      return {
        ok: false,
        reason: `exclude[${index}] names unknown slice ${exclusion.sliceId}`,
      };
    }
    if (include.has(exclusion.sliceId) || exclude.has(exclusion.sliceId)) {
      return { ok: false, reason: `slice ${exclusion.sliceId} appears more than once` };
    }
    exclude.set(exclusion.sliceId, exclusion.reason.trim());
  }

  for (const requiredSliceId of requiredSliceIds) {
    if (!include.has(requiredSliceId)) {
      return {
        ok: false,
        reason: `entry-point slice ${requiredSliceId} must be included`,
      };
    }
  }
  for (const candidate of candidates) {
    if (!include.has(candidate.id) && !exclude.has(candidate.id)) {
      return { ok: false, reason: `slice ${candidate.id} is missing from the partition` };
    }
  }
  return { ok: true, selection: { include, exclude } };
}

function duplicateCandidateId(candidates: readonly PartitionSlice[]): string | undefined {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) return candidate.id;
    seen.add(candidate.id);
  }
  return undefined;
}

export async function runMapScope(input: MapScopeInput): Promise<MapScopeResult> {
  const { snapshot, candidates, provenance, runTurn } = input;
  const seededProvenance = provenanceFrom(provenance);
  const duplicateId = duplicateCandidateId(candidates);
  if (duplicateId !== undefined) {
    return {
      status: "failed",
      failureReason: `candidate slice id ${duplicateId} appears more than once`,
      provenance: seededProvenance,
      attempts: 0,
    };
  }
  if (candidates.length <= MAP_SCOPE_SLICE_CAP) {
    return {
      status: "ok",
      includedSliceIds: candidates.map((candidate) => candidate.id),
      excludedSlices: [],
      provenance: seededProvenance,
      attempts: 0,
    };
  }

  const facts = mapScopeCatalogueFacts(snapshot, candidates);
  if (facts.requiredSliceIds.size > MAP_SCOPE_SLICE_CAP) {
    return {
      status: "failed",
      failureReason: `${facts.requiredSliceIds.size} entry-point slices exceed the ${MAP_SCOPE_SLICE_CAP}-slice cap`,
      provenance: seededProvenance,
      attempts: 0,
    };
  }

  const prompt = buildPrompt(facts.catalogue);
  let lastFailure = "map scope did not complete";
  let lastProvenance = seededProvenance;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const turn = await runTurn(prompt, attempt);
    if (turn.status === "failed") {
      lastFailure = turn.message;
      continue;
    }
    lastProvenance = provenanceFrom(provenance, turn.observed);
    const validated = validateSelection(turn.body, candidates, facts.requiredSliceIds);
    if (!validated.ok) {
      lastFailure = validated.reason;
      continue;
    }
    return {
      status: "ok",
      includedSliceIds: candidates
        .filter((candidate) => validated.selection.include.has(candidate.id))
        .map((candidate) => candidate.id),
      excludedSlices: candidates.flatMap((candidate) => {
        const reason = validated.selection.exclude.get(candidate.id);
        return reason === undefined ? [] : [{ sliceId: candidate.id, reason }];
      }),
      provenance: lastProvenance,
      attempts: attempt + 1,
    };
  }
  return {
    status: "failed",
    failureReason: lastFailure,
    provenance: lastProvenance,
    attempts: 2,
  };
}

function coverageSelector(
  selection: MapScopeSuccess,
  selector: MapScopeSelectorProvenance,
): KnowledgeCoverage["selector"] {
  if (selector.kind === "below-cap") {
    return {
      kind: "below-cap",
      cap: MAP_SCOPE_SLICE_CAP,
      generator: MAP_SCOPE_GENERATOR_ID,
    };
  }
  if (
    selection.provenance.model !== selector.model ||
    selection.provenance.apiKeySource !== selector.apiKeySource
  ) {
    throw new Error("selector provenance does not match the map-scope result");
  }
  return {
    kind: "council",
    cap: MAP_SCOPE_SLICE_CAP,
    generator: MAP_SCOPE_GENERATOR_ID,
    harness: selector.harness,
    assignedModel: selector.assignedModel,
    model: selector.model,
    effort: selector.effort,
    apiKeySource: selector.apiKeySource,
  };
}

function selectionDecisions(
  selection: MapScopeSuccess,
  candidates: readonly PartitionSlice[],
): ReadonlyMap<
  string,
  { readonly kind: "mapped" } | { readonly kind: "excluded"; reason: string }
> {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  if (candidateIds.size !== candidates.length)
    throw new Error("candidate slice IDs are not unique");
  const decisions = new Map<
    string,
    { readonly kind: "mapped" } | { readonly kind: "excluded"; reason: string }
  >();
  for (const sliceId of selection.includedSliceIds) {
    if (!candidateIds.has(sliceId)) throw new Error(`selection names unknown slice ${sliceId}`);
    if (decisions.has(sliceId)) throw new Error(`selection repeats slice ${sliceId}`);
    decisions.set(sliceId, { kind: "mapped" });
  }
  for (const exclusion of selection.excludedSlices) {
    if (!candidateIds.has(exclusion.sliceId)) {
      throw new Error(`selection names unknown slice ${exclusion.sliceId}`);
    }
    if (decisions.has(exclusion.sliceId)) {
      throw new Error(`selection repeats slice ${exclusion.sliceId}`);
    }
    const reason = exclusion.reason.trim();
    if (reason.length === 0)
      throw new Error(`selection has a blank reason for ${exclusion.sliceId}`);
    decisions.set(exclusion.sliceId, { kind: "excluded", reason });
  }
  for (const candidate of candidates) {
    if (!decisions.has(candidate.id)) throw new Error(`selection omits slice ${candidate.id}`);
  }
  return decisions;
}

export function materializeKnowledgeCoverage(
  input: MaterializeKnowledgeCoverageInput,
): KnowledgeCoverage {
  const { snapshot, candidates, selection, selector } = input;
  const facts = mapScopeCatalogueFacts(snapshot, candidates);
  const decisions = selectionDecisions(selection, candidates);
  const mappedSlices = [...decisions.values()].filter(
    (decision) => decision.kind === "mapped",
  ).length;
  if (candidates.length <= MAP_SCOPE_SLICE_CAP) {
    if (selector.kind !== "below-cap" || mappedSlices !== candidates.length) {
      throw new Error("at-or-below-cap coverage must deterministically map every candidate slice");
    }
  } else if (
    selector.kind !== "council" ||
    mappedSlices === 0 ||
    mappedSlices > MAP_SCOPE_SLICE_CAP
  ) {
    throw new Error(
      `above-cap coverage must use the council selector and map 1..${MAP_SCOPE_SLICE_CAP} slices`,
    );
  }
  for (const sliceId of facts.requiredSliceIds) {
    if (decisions.get(sliceId)?.kind !== "mapped") {
      throw new Error(`entry-point slice ${sliceId} must be mapped`);
    }
  }
  const snapshotByPath = new Map<string, KnowledgeCoverageFile>();
  for (const file of snapshot.files) {
    if (snapshotByPath.has(file.path)) throw new Error(`snapshot repeats path ${file.path}`);
    snapshotByPath.set(file.path, { path: file.path, blobOid: file.blobOid });
  }
  const eligibilityByPath = new Map(facts.classified.map((entry) => [entry.path, entry] as const));
  const coveredPaths = new Set<string>();
  const groups: KnowledgeCoverageGroup[] = [];

  for (const candidate of candidates) {
    const decision = decisions.get(candidate.id);
    if (decision === undefined) throw new Error(`selection omits slice ${candidate.id}`);
    if (candidate.files.length === 0)
      throw new Error(`candidate slice ${candidate.id} has no files`);
    const files = [...candidate.files]
      .sort((left, right) => byString(left.path, right.path))
      .map((member) => {
        const snapshotFile = snapshotByPath.get(member.path);
        if (snapshotFile === undefined)
          throw new Error(`candidate path ${member.path} is not in snapshot`);
        if (snapshotFile.blobOid !== member.blobOid) {
          throw new Error(`candidate path ${member.path} has the wrong blob`);
        }
        if (eligibilityByPath.get(member.path)?.ineligible !== null) {
          throw new Error(`candidate path ${member.path} is mechanically ineligible`);
        }
        if (coveredPaths.has(member.path))
          throw new Error(`candidate path ${member.path} appears twice`);
        coveredPaths.add(member.path);
        return snapshotFile;
      });
    groups.push(
      decision.kind === "mapped"
        ? { kind: "mapped", sliceId: candidate.id, files }
        : {
            kind: "excluded",
            source: "scope",
            sliceId: candidate.id,
            reason: decision.reason,
            files,
          },
    );
  }

  for (const reason of MECHANICAL_REASONS) {
    const files = facts.classified.flatMap((entry) => {
      if (entry.ineligible !== reason) return [];
      const file = snapshotByPath.get(entry.path);
      if (file === undefined) throw new Error(`classified path ${entry.path} is not in snapshot`);
      if (coveredPaths.has(entry.path))
        throw new Error(`coverage path ${entry.path} appears twice`);
      coveredPaths.add(entry.path);
      return [file];
    });
    if (files.length > 0) {
      groups.push({ kind: "excluded", source: "mechanical", reason, files });
    }
  }

  if (coveredPaths.size !== snapshotByPath.size) {
    const missing = [...snapshotByPath.keys()]
      .filter((path) => !coveredPaths.has(path))
      .sort(byString);
    throw new Error(`coverage omits snapshot paths: ${missing.join(", ")}`);
  }

  return {
    schemaVersion: 1,
    catalogueDigest: catalogueDigest(facts.catalogue),
    selector: coverageSelector(selection, selector),
    groups,
  };
}
