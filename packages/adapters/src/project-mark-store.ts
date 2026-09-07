/**
 * The project mark's logo store (#900, ADR 0004).
 *
 * A logo that identifies a project lives as BYTES under the host's per-project directory
 * (`~/.rennet/projects/<escaped-path>/mark-<kind>.<ext>`), copied there once when the scout
 * detects it or when the user uploads one. It is not read out of the checkout on demand: a
 * mark is a property of the project, not of whichever worktree or branch happens to be out,
 * the repo may delete or move the file without the project losing its mark, and an uploaded
 * logo needs a Rennet-owned home in any case — so one store serves both kinds.
 *
 * Beside each file sits `mark-<kind>.json` holding its provenance (`{ source }`): the
 * repo-relative path the scout chose, or the uploaded file's name. That is what the Identity
 * tile shows, and it is never model-facing.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProjectLogoKind, ProjectLogoMime } from "@rennet/protocol";
import type { ProjectSnapshotStore } from "./project-snapshot-store";
import { writeAtomic } from "./write-atomic";

/**
 * MIME ↔ extension, ONE table. `ext` is the canonical extension a stored file gets;
 * `reads` are the extensions found in a repository that map back to the same MIME, so a
 * `.jpeg` in the checkout is copied to a `.jpg` here and still reads as `image/jpeg`.
 */
const MARK_FORMATS: readonly {
  readonly mime: ProjectLogoMime;
  readonly ext: string;
  readonly reads: readonly string[];
}[] = [
  { mime: "image/svg+xml", ext: "svg", reads: ["svg"] },
  { mime: "image/png", ext: "png", reads: ["png"] },
  { mime: "image/jpeg", ext: "jpg", reads: ["jpg", "jpeg"] },
  { mime: "image/webp", ext: "webp", reads: ["webp"] },
];

/** The canonical stored extension for a MIME. */
export function extensionForLogoMime(mime: ProjectLogoMime): string {
  const format = MARK_FORMATS.find((entry) => entry.mime === mime);
  if (!format) throw new Error(`No stored extension for ${mime}`);
  return format.ext;
}

/** The MIME one file extension (with or without its dot) means, or undefined for anything
 *  outside the accepted set — which is how an unsupported image is refused at the copy. */
export function logoMimeForExtension(extension: string): ProjectLogoMime | undefined {
  const ext = extension.replace(/^\./, "").toLowerCase();
  return MARK_FORMATS.find((entry) => entry.reads.includes(ext))?.mime;
}

/** One stored logo file: where it is and what it is. */
export interface ProjectLogoFile {
  readonly path: string;
  readonly mimeType: ProjectLogoMime;
}

/** One stored logo as the wire carries it (ADR 0004: bytes ride base64, no static route). */
export interface StoredProjectLogo {
  readonly mimeType: ProjectLogoMime;
  readonly bytesBase64: string;
  /** The repo-relative path the scout chose, or the uploaded file's name. */
  readonly source: string;
}

function markBase(store: ProjectSnapshotStore, repoKey: string, kind: ProjectLogoKind): string {
  return join(store.paths(repoKey).projectDir, `mark-${kind}`);
}

/**
 * The logo file a project holds for one kind, discovered BY EXTENSION — the store never
 * records which format it wrote, it looks. Deterministic: {@link MARK_FORMATS} is the order.
 */
export function logoFile(
  store: ProjectSnapshotStore,
  repoKey: string,
  kind: ProjectLogoKind,
): ProjectLogoFile | null {
  const base = markBase(store, repoKey, kind);
  for (const format of MARK_FORMATS) {
    const path = `${base}.${format.ext}`;
    if (existsSync(path)) return { path, mimeType: format.mime };
  }
  return null;
}

/** True when this project holds a DETECTED logo — the fact the `mark` ladder's `detected`
 *  rung is offered on. A copy that is not on disk offers nothing, which is the honest read. */
export function detectedLogoExists(store: ProjectSnapshotStore, repoKey: string): boolean {
  return logoFile(store, repoKey, "detected") !== null;
}

/** Read one stored logo, bytes and provenance, or null when the project holds none. */
export function readLogo(
  store: ProjectSnapshotStore,
  repoKey: string,
  kind: ProjectLogoKind,
): StoredProjectLogo | null {
  const file = logoFile(store, repoKey, kind);
  if (!file) return null;
  try {
    const bytesBase64 = readFileSync(file.path).toString("base64");
    return { mimeType: file.mimeType, bytesBase64, source: readSidecar(store, repoKey, kind) };
  } catch {
    // A file that vanished between the discovery and the read is an honest absence, not a
    // throw: the caller is answering a list read for every project at once.
    return null;
  }
}

/** `mark-<kind>.json` → its `source`, or "" when the sidecar is absent or malformed. A
 *  provenance line nobody can vouch for is shown as blank, never invented from the path. */
function readSidecar(store: ProjectSnapshotStore, repoKey: string, kind: ProjectLogoKind): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(`${markBase(store, repoKey, kind)}.json`, "utf8"),
    );
    const source = (parsed as { source?: unknown } | null)?.source;
    return typeof source === "string" ? source : "";
  } catch {
    return "";
  }
}

/** Drop every stored file for one kind, whatever extension it has — so a re-detect that
 *  finds a `.svg` cannot leave the previous `.png` behind for `logoFile` to find first. */
function clearKind(store: ProjectSnapshotStore, repoKey: string, kind: ProjectLogoKind): void {
  const base = markBase(store, repoKey, kind);
  for (const format of MARK_FORMATS) rmSync(`${base}.${format.ext}`, { force: true });
  rmSync(`${base}.json`, { force: true });
}

function writeLogoBytes(
  store: ProjectSnapshotStore,
  repoKey: string,
  kind: ProjectLogoKind,
  mimeType: ProjectLogoMime,
  bytes: Buffer,
  source: string,
): ProjectLogoFile {
  const projectDir = store.paths(repoKey).projectDir;
  mkdirSync(projectDir, { recursive: true });
  clearKind(store, repoKey, kind);
  const path = `${markBase(store, repoKey, kind)}.${extensionForLogoMime(mimeType)}`;
  writeAtomic(path, bytes);
  writeAtomic(`${markBase(store, repoKey, kind)}.json`, `${JSON.stringify({ source })}\n`);
  return { path, mimeType };
}

/**
 * Copy a repository file in as this project's DETECTED mark. `relativePath` is resolved
 * against `repoRoot` — the root the scout recorded on the fact, never the project's open
 * path — and validated the same way the scout validated the seat's pick: realpath both
 * sides, require containment, require a file, require an accepted extension. Anything that
 * fails returns null and leaves the previous copy in place.
 */
export function copyDetectedLogo(
  store: ProjectSnapshotStore,
  repoKey: string,
  repoRoot: string,
  relativePath: string,
): ProjectLogoFile | null {
  let source: string;
  let mimeType: ProjectLogoMime | undefined;
  try {
    const root = realpathSync(repoRoot);
    const target = realpathSync(resolve(root, relativePath));
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    if (!statSync(target).isFile()) return null;
    const dot = target.lastIndexOf(".");
    mimeType = dot > 0 ? logoMimeForExtension(target.slice(dot)) : undefined;
    if (!mimeType) return null;
    source = target;
  } catch {
    return null;
  }
  try {
    return writeLogoBytes(store, repoKey, "detected", mimeType, readFileSync(source), relativePath);
  } catch {
    return null;
  }
}

/** Store the bytes the user picked as this project's UPLOADED mark. The MIME is already
 *  narrowed by the wire schema; the file name rides along as the tile's provenance line. */
export function writeUploadLogo(
  store: ProjectSnapshotStore,
  repoKey: string,
  mimeType: ProjectLogoMime,
  bytes: Buffer,
  fileName: string,
): ProjectLogoFile {
  return writeLogoBytes(store, repoKey, "upload", mimeType, bytes, fileName);
}
