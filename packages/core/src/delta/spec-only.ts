// core/delta/spec-only — is this change made of specification artifacts and nothing else?
//
// A branch that carries only a specification (an OpenSpec change proposed ahead of its
// code, a Kiro feature's requirements, an ADR) has no code to read in order, no engineering
// decision a diff could show, nothing to flag, and nothing mechanical to file as noise. The
// Design lens is the whole review of such a change, and it renders the specification on the
// host with no model turn when the format is one the assembler reads. Dispatching the other
// four seats over it is four paid turns to be told there is no code here — and, worse, four
// seats that will find SOMETHING to say about prose that is not theirs to judge.
//
// So the pipeline asks this question once, from the patchset's file rows, before any lane
// opens. It is pure and path-shaped: a fact the packet already carries, decided the same way
// every time, never a model's opinion. The roots below are the ones the Design readers and
// the Design prompt already name; a format the Design lens cannot read is not a specification
// for this purpose, so a docs-only or README-only branch is an ordinary change.

/** A file row as the delta packet carries it: the path, and the old path of a rename. */
export interface SpecOnlyFileRow {
  readonly path: string;
  readonly previousPath?: string;
}

/**
 * The directory roots under which every file is a specification artifact. Prefix-matched
 * on the normalised repo-relative path, so `openspec/changes/README.md` and
 * `openspec/specs/<capability>/spec.md` both count: the whole tree is the specification
 * workflow's, whichever file of it a change touches.
 */
export const SPEC_ARTIFACT_ROOTS: readonly string[] = [
  "openspec/",
  ".kiro/",
  ".bmad/",
  ".bmad-core/",
  "docs/superpowers/",
  ".superpowers/",
];

/** A `docs/adr/` or `docs/decisions/` directory at any depth (the grill-with-docs reader's rule). */
const ADR_DIR = /(^|\/)docs\/(adr|decisions)\/[^/]+\.md$/i;

/** The grill-with-docs context documents, by basename, anywhere in the tree. */
const CONTEXT_BASENAMES: ReadonlySet<string> = new Set(["context.md", "context-map.md"]);

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True when `path` is a file the Design lens reads as a specification artifact. */
export function isSpecArtifactPath(path: string): boolean {
  const normalised = normalise(path);
  if (SPEC_ARTIFACT_ROOTS.some((root) => normalised.startsWith(root))) return true;
  if (ADR_DIR.test(normalised)) return true;
  const basename = normalised.split("/").at(-1) ?? "";
  return CONTEXT_BASENAMES.has(basename.toLowerCase());
}

/**
 * True when the change touches at least one file and EVERY touched path — a rename's old
 * side included, because a file moved out of a spec directory into `src/` is a code change
 * — is a specification artifact. An empty inventory is not spec-only: a change with no
 * files has nothing for Design to render either, and the ordinary lanes are what say so.
 */
export function isSpecOnlyChange(files: readonly SpecOnlyFileRow[]): boolean {
  if (files.length === 0) return false;
  for (const file of files) {
    if (!isSpecArtifactPath(file.path)) return false;
    if (file.previousPath !== undefined && !isSpecArtifactPath(file.previousPath)) return false;
  }
  return true;
}
