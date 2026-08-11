import {
  buildSnapshot,
  DEFAULT_REFERENCE_EXTRACTOR_ID,
  DEFAULT_SYMBOL_EXTRACTOR_ID,
  eligibleSymbolFiles,
  extractReferenceShard,
  extractSymbolShard,
  indexReferenceShards,
  indexSymbolShards,
  planIncrementalReferences,
  planIncrementalSymbols,
  type SnapshotReferenceExtractor,
  type SnapshotStructuralInputs,
  type SnapshotSymbolExtractor,
  structuralReferenceExtractor,
  structuralTsExtractor,
  verifySnapshotIntegrity,
} from "@rennet/core";
import type {
  BuiltSnapshot,
  ProjectSnapshotManifest,
  ReferenceShard,
  SymbolShard,
} from "@rennet/types";
import { execaGit, type GitExec } from "./git-range-diff";
import {
  listTree,
  readBlobText,
  readConventions,
  readOwnership,
  readTests,
  readWorkspaceStructure,
  resolveBaseRef,
} from "./project-snapshot-source";
import type { ProjectSnapshotStore } from "./project-snapshot-store";

/**
 * The ProjectSnapshot generator (#14, Part 1) — the orchestration that ties the
 * deterministic git/workspace source, the pure core builder, and the app-owned
 * store together.
 *
 * The two build modes are byte-equivalent by construction:
 *  - a CLEAN FULL build extracts symbols for every eligible file;
 *  - an INCREMENTAL build reuses the previous snapshot's symbol shards for
 *    unchanged blobs (content-addressed, so reuse is free) and extracts only the
 *    changed closure.
 * Because symbol shards are addressed by blob content, both paths pass the core
 * builder a byte-identical shard set, so both produce a byte-identical snapshot.
 * The integration test asserts exactly this against a real git repository.
 *
 * Every generated snapshot is verified (`verifySnapshotIntegrity`) BEFORE the
 * store advances, so a stale/corrupt shard can never be committed as current.
 */
export interface GenerateOptions {
  /** An explicit default-branch ref, overriding git-local resolution. */
  readonly explicitBaseRef?: string;
  /** The symbol extractor (defaults to the structural TS/JS extractor). */
  readonly extractor?: SnapshotSymbolExtractor;
  /** The extractor identity, stamped on shards for honest invalidation. */
  readonly extractorId?: string;
  /**
   * A source of previous symbol shards to reuse (the store's current snapshot by
   * default). Pass an empty array to force a clean full build regardless of the
   * store.
   */
  readonly previousSymbols?: readonly SymbolShard[];
  /** The reference extractor (defaults to the structural identifier-occurrence extractor). */
  readonly referenceExtractor?: SnapshotReferenceExtractor;
  /** The reference-extractor identity, stamped on reference shards for honest invalidation. */
  readonly referenceExtractorId?: string;
  /**
   * A source of previous REFERENCE shards to reuse (the store's current snapshot by
   * default). Pass an empty array to force a clean full reference build.
   */
  readonly previousReferences?: readonly ReferenceShard[];
}

export interface GenerateResult {
  readonly built: BuiltSnapshot;
  readonly manifest: ProjectSnapshotManifest;
  /** How many symbol shards were reused verbatim from the previous snapshot. */
  readonly reusedSymbolShards: number;
  /** How many files had their symbols freshly extracted (the changed closure). */
  readonly extractedSymbolShards: number;
  /** How many reference shards were reused verbatim from the previous snapshot. */
  readonly reusedReferenceShards: number;
  /** How many files had their references freshly extracted (the changed closure). */
  readonly extractedReferenceShards: number;
}

export class ProjectSnapshotGenerator {
  constructor(private readonly deps: { git?: GitExec; store?: ProjectSnapshotStore } = {}) {}

  private get git(): GitExec {
    return this.deps.git ?? execaGit;
  }

  /**
   * Gather the deterministic structural inputs at the resolved base OID. Pure
   * over git: no working-tree reads, no live tooling daemon.
   */
  async gather(
    repoRoot: string,
    options: GenerateOptions = {},
  ): Promise<{
    inputs: SnapshotStructuralInputs;
    eligible: ReturnType<typeof eligibleSymbolFiles>;
    /** The resolved top-level working directory, for OID-addressed blob reads. */
    root: string;
  }> {
    const base = await resolveBaseRef(repoRoot, {
      git: this.git,
      explicitBaseRef: options.explicitBaseRef,
    });
    const files = await listTree(base.root, base.baseOid, this.git);
    const workspace = await readWorkspaceStructure(base.root, files, this.git);
    const conventions = readConventions(files);
    const ownership = await readOwnership(base.root, files, this.git);
    const tests = readTests(files, workspace.scopes);

    const inputs: SnapshotStructuralInputs = {
      repoKey: base.repoKey,
      baseRef: base.baseRef,
      baseRefResolution: base.baseRefResolution,
      baseOid: base.baseOid,
      files,
      scopes: workspace.scopes,
      edges: workspace.edges,
      entryPoints: workspace.entryPoints,
      tests,
      ownership,
      conventions,
    };
    return { inputs, eligible: eligibleSymbolFiles(files), root: base.root };
  }

  /**
   * Build (and, when a store is configured, persist) the snapshot for a repo.
   * Reuses the store's current symbol shards for unchanged blobs unless
   * `previousSymbols` is given (an empty array forces a clean full build).
   */
  async generate(repoRoot: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const extractor = options.extractor ?? structuralTsExtractor;
    const extractorId = options.extractorId ?? DEFAULT_SYMBOL_EXTRACTOR_ID;
    const referenceExtractor = options.referenceExtractor ?? structuralReferenceExtractor;
    const referenceExtractorId = options.referenceExtractorId ?? DEFAULT_REFERENCE_EXTRACTOR_ID;
    const { inputs, eligible, root } = await this.gather(repoRoot, options);

    const previousSymbolShards =
      options.previousSymbols ?? this.loadPreviousSymbols(inputs.repoKey);
    const previousReferenceShards =
      options.previousReferences ?? this.loadPreviousReferences(inputs.repoKey);
    const plan = planIncrementalSymbols(
      eligible,
      indexSymbolShards(previousSymbolShards),
      extractorId,
    );
    const refPlan = planIncrementalReferences(
      eligible,
      indexReferenceShards(previousReferenceShards),
      referenceExtractorId,
    );

    // Read each blob's text ONCE for the union of files that need symbol OR reference
    // extraction, and derive whichever shard(s) are missing from that single read.
    const symbolToExtract = new Map(plan.toExtract.map((f) => [f.blobOid, f] as const));
    const referenceToExtract = new Map(refPlan.toExtract.map((f) => [f.blobOid, f] as const));
    const toRead = new Map<string, (typeof plan.toExtract)[number]>();
    for (const file of plan.toExtract) toRead.set(file.blobOid, file);
    for (const file of refPlan.toExtract) toRead.set(file.blobOid, file);

    const extracted: SymbolShard[] = [];
    const extractedReferences: ReferenceShard[] = [];
    for (const file of toRead.values()) {
      const text = await readBlobText(root, file.blobOid, this.git);
      if (symbolToExtract.has(file.blobOid)) {
        extracted.push(extractSymbolShard(file, text, extractor, extractorId));
      }
      if (referenceToExtract.has(file.blobOid)) {
        extractedReferences.push(
          extractReferenceShard(file, text, referenceExtractor, referenceExtractorId),
        );
      }
    }

    const built = buildSnapshot(
      inputs,
      [...plan.reuse, ...extracted],
      [...refPlan.reuse, ...extractedReferences],
    );

    // Verify BEFORE advancing: a stale/corrupt/tampered shard fails closed here
    // and is never committed as the current snapshot.
    const integrity = verifySnapshotIntegrity(built.manifest, (digest) => built.shards.get(digest));
    if (!integrity.ok) {
      throw new Error(
        `ProjectSnapshot integrity check failed before advance: missing=${integrity.missing.length} mismatched=${integrity.mismatched.length}`,
      );
    }

    this.deps.store?.advance(built);

    return {
      built,
      manifest: built.manifest,
      reusedSymbolShards: plan.reuse.length,
      extractedSymbolShards: plan.toExtract.length,
      reusedReferenceShards: refPlan.reuse.length,
      extractedReferenceShards: refPlan.toExtract.length,
    };
  }

  private loadPreviousSymbols(repoKey: string): readonly SymbolShard[] {
    const store = this.deps.store;
    if (!store) return [];
    const manifest = store.loadManifest(repoKey);
    if (!manifest) return [];
    return store.loadSymbolShards(manifest);
  }

  private loadPreviousReferences(repoKey: string): readonly ReferenceShard[] {
    const store = this.deps.store;
    if (!store) return [];
    const manifest = store.loadManifest(repoKey);
    if (!manifest) return [];
    return store.loadReferenceShards(manifest);
  }
}
