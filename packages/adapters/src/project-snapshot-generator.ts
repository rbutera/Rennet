import {
  buildSnapshot,
  DEFAULT_IMPORT_EXTRACTOR_ID,
  DEFAULT_REFERENCE_EXTRACTOR_ID,
  DEFAULT_SYMBOL_EXTRACTOR_ID,
  eligibleSymbolFiles,
  extractImportShard,
  extractReferenceShard,
  extractSymbolShard,
  indexImportShards,
  indexReferenceShards,
  indexSymbolShards,
  planIncrementalImports,
  planIncrementalReferences,
  planIncrementalSymbols,
  type SnapshotImportExtractor,
  type SnapshotReferenceExtractor,
  type SnapshotStructuralInputs,
  type SnapshotSymbolExtractor,
  structuralFactFiles,
  structuralImportExtractor,
  structuralReferenceExtractor,
  structuralTsExtractor,
  verifySnapshotIntegrity,
} from "@rennet/core";
import type {
  BuiltSnapshot,
  ImportShard,
  ProjectSnapshotManifest,
  ReferenceShard,
  SymbolShard,
} from "@rennet/protocol";
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
  /** The import extractor (defaults to the structural import-specifier extractor). */
  readonly importExtractor?: SnapshotImportExtractor;
  /** The import-extractor identity, stamped on import shards for honest invalidation. */
  readonly importExtractorId?: string;
  /**
   * A source of previous IMPORT shards to reuse (the store's current snapshot by
   * default). Pass an empty array to force a clean full import build.
   */
  readonly previousImports?: readonly ImportShard[];
  /**
   * An optional sink for live build progress, called once as each real stage
   * begins/completes (see {@link SnapshotBuildStage}). Wired to the desktop app's
   * processing screen so the narration is honest — every line reflects a step the
   * generator actually performed. Omitted by every non-interactive caller.
   */
  readonly onProgress?: (progress: SnapshotBuildProgress) => void;
}

/**
 * The real stages of a snapshot build, in the order they execute. Each is a step
 * {@link ProjectSnapshotGenerator.generate} genuinely performs — the desktop
 * processing screen maps these to live narration.
 */
export type SnapshotBuildStage =
  | "resolve"
  | "tree"
  | "workspace"
  | "conventions"
  | "symbols"
  | "build"
  | "verify"
  | "store";

/** A single live build-progress datum: which stage, a friendly note, an optional real detail. */
export interface SnapshotBuildProgress {
  readonly stage: SnapshotBuildStage;
  /** A present-tense line describing the step ("Reading the file tree"). */
  readonly note: string;
  /** A concrete, real detail when known ("412 files", "main"). */
  readonly detail?: string;
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
  /** How many import shards were reused verbatim from the previous snapshot. */
  readonly reusedImportShards: number;
  /** How many files had their imports freshly extracted (the changed closure). */
  readonly extractedImportShards: number;
  /** Total files in the tree at the base OID (the whole snapshot's breadth). */
  readonly fileCount: number;
  /** Total DECLARED SYMBOLS across all shards (not the shard/file count). */
  readonly symbolCount: number;
  /** Total identifier OCCURRENCES across all reference shards (not the shard count). */
  readonly referenceCount: number;
}

export class ProjectSnapshotGenerator {
  constructor(
    private readonly deps: {
      git?: GitExec;
      gitForRepo?: (repoRoot: string) => GitExec;
      store?: ProjectSnapshotStore;
    } = {},
  ) {}

  private gitFor(repoRoot: string): GitExec {
    return this.deps.gitForRepo?.(repoRoot) ?? this.deps.git ?? execaGit;
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
    /** Files the symbol/reference/import EXTRACTORS understand (TypeScript/JavaScript). */
    eligible: ReturnType<typeof eligibleSymbolFiles>;
    /**
     * Files a per-blob structural-facts (symbol) shard is emitted for — the wider set
     * that carries the inventory-wide generated-banner bit. See
     * {@link structuralFactFiles}.
     */
    structuralFacts: ReturnType<typeof structuralFactFiles>;
    /** The resolved top-level working directory, for OID-addressed blob reads. */
    root: string;
  }> {
    const progress = options.onProgress;
    const git = this.gitFor(repoRoot);
    progress?.({ stage: "resolve", note: "Finding the default branch" });
    const base = await resolveBaseRef(repoRoot, {
      git,
      explicitBaseRef: options.explicitBaseRef,
    });
    progress?.({ stage: "resolve", note: "Finding the default branch", detail: base.baseRef });

    progress?.({ stage: "tree", note: "Reading the file tree" });
    const files = await listTree(base.root, base.baseOid, git);
    progress?.({
      stage: "tree",
      note: "Reading the file tree",
      detail: `${files.length} ${files.length === 1 ? "file" : "files"}`,
    });

    progress?.({ stage: "workspace", note: "Mapping the workspace" });
    const workspace = await readWorkspaceStructure(base.root, files, git);
    progress?.({
      stage: "workspace",
      note: "Mapping the workspace",
      detail: `${workspace.scopes.length} ${workspace.scopes.length === 1 ? "scope" : "scopes"}`,
    });

    progress?.({ stage: "conventions", note: "Learning conventions & ownership" });
    const conventions = readConventions(files);
    const ownership = await readOwnership(base.root, files, git);
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
    return {
      inputs,
      eligible: eligibleSymbolFiles(files),
      structuralFacts: structuralFactFiles(files),
      root: base.root,
    };
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
    const importExtractor = options.importExtractor ?? structuralImportExtractor;
    const importExtractorId = options.importExtractorId ?? DEFAULT_IMPORT_EXTRACTOR_ID;
    const { inputs, eligible, structuralFacts, root } = await this.gather(repoRoot, options);
    const git = this.gitFor(repoRoot);

    const previousSymbolShards =
      options.previousSymbols ?? this.loadPreviousSymbols(inputs.repoKey);
    const previousReferenceShards =
      options.previousReferences ?? this.loadPreviousReferences(inputs.repoKey);
    const previousImportShards =
      options.previousImports ?? this.loadPreviousImports(inputs.repoKey);
    // Symbol shards ride the WIDER set: they carry the generated-banner bit, which
    // has to be inventory-wide to catch a generated `.py`. References and imports
    // stay on the extractor's own languages — indexing every identifier in every
    // markdown file would be noise, not coverage.
    const plan = planIncrementalSymbols(
      structuralFacts,
      indexSymbolShards(previousSymbolShards),
      extractorId,
    );
    const refPlan = planIncrementalReferences(
      eligible,
      indexReferenceShards(previousReferenceShards),
      referenceExtractorId,
    );
    const importPlan = planIncrementalImports(
      eligible,
      indexImportShards(previousImportShards),
      importExtractorId,
    );

    // Read each blob's text ONCE for the union of files that need symbol, reference OR
    // import extraction, and derive whichever shard(s) are missing from that single read.
    const symbolToExtract = new Set(plan.toExtract.map((f) => f.blobOid));
    const referenceToExtract = new Set(refPlan.toExtract.map((f) => f.blobOid));
    const importToExtract = new Set(importPlan.toExtract.map((f) => f.blobOid));
    const toRead = new Map<string, (typeof plan.toExtract)[number]>();
    for (const file of plan.toExtract) toRead.set(file.blobOid, file);
    for (const file of refPlan.toExtract) toRead.set(file.blobOid, file);
    for (const file of importPlan.toExtract) toRead.set(file.blobOid, file);

    const progress = options.onProgress;
    progress?.({
      stage: "symbols",
      note: "Extracting symbols, references & imports",
      detail:
        toRead.size === 0
          ? "reusing cached symbols"
          : `${toRead.size} ${toRead.size === 1 ? "file" : "files"} to parse`,
    });
    const extracted: SymbolShard[] = [];
    const extractedReferences: ReferenceShard[] = [];
    const extractedImports: ImportShard[] = [];
    for (const file of toRead.values()) {
      const text = await readBlobText(root, file.blobOid, git);
      if (symbolToExtract.has(file.blobOid)) {
        extracted.push(extractSymbolShard(file, text, extractor, extractorId));
      }
      if (referenceToExtract.has(file.blobOid)) {
        extractedReferences.push(
          extractReferenceShard(file, text, referenceExtractor, referenceExtractorId),
        );
      }
      if (importToExtract.has(file.blobOid)) {
        extractedImports.push(extractImportShard(file, text, importExtractor, importExtractorId));
      }
    }

    progress?.({ stage: "build", note: "Building the repo map" });
    const symbolShards = [...plan.reuse, ...extracted];
    const referenceShards = [...refPlan.reuse, ...extractedReferences];
    const importShards = [...importPlan.reuse, ...extractedImports];
    const built = buildSnapshot(inputs, symbolShards, referenceShards, importShards);

    // Real totals over the built shards — NOT shard COUNTS. `manifest.symbols` is
    // a per-blob pointer array (one entry per file), so its length is a file count;
    // the honest "symbols indexed" is the sum of each shard's declared symbols, and
    // "references indexed" is the sum of every identifier's occurrences.
    const symbolCount = symbolShards.reduce((sum, shard) => sum + shard.symbols.length, 0);
    const referenceCount = referenceShards.reduce(
      (sum, shard) =>
        sum + shard.references.reduce((refSum, occurrence) => refSum + occurrence.lines.length, 0),
      0,
    );

    // Verify BEFORE advancing: a stale/corrupt/tampered shard fails closed here
    // and is never committed as the current snapshot.
    progress?.({ stage: "verify", note: "Verifying integrity" });
    const integrity = verifySnapshotIntegrity(built.manifest, (digest) => built.shards.get(digest));
    if (!integrity.ok) {
      throw new Error(
        `ProjectSnapshot integrity check failed before advance: missing=${integrity.missing.length} mismatched=${integrity.mismatched.length}`,
      );
    }

    if (this.deps.store) {
      progress?.({ stage: "store", note: "Saving the snapshot" });
      this.deps.store.advance(built);
    }

    return {
      built,
      manifest: built.manifest,
      reusedSymbolShards: plan.reuse.length,
      extractedSymbolShards: plan.toExtract.length,
      reusedReferenceShards: refPlan.reuse.length,
      extractedReferenceShards: refPlan.toExtract.length,
      reusedImportShards: importPlan.reuse.length,
      extractedImportShards: importPlan.toExtract.length,
      fileCount: inputs.files.length,
      symbolCount,
      referenceCount,
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

  private loadPreviousImports(repoKey: string): readonly ImportShard[] {
    const store = this.deps.store;
    if (!store) return [];
    const manifest = store.loadManifest(repoKey);
    if (!manifest) return [];
    return store.loadImportShards(manifest);
  }
}
