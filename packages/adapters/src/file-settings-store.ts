import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  permissionModeSchema,
} from "@rennet/protocol";

/**
 * The workspace settings persistence (issue #103). A minimal JSON-file-backed
 * store for the single setting that exists today — the permission mode — sized
 * to be extended into the #28 settings surface without a schema migration.
 *
 * It is deliberately NOT the `SqliteReviewStore`: settings are workspace-level
 * config, not per-review event history, and coupling a KV setting to the review
 * event log would muddy both. A separate ~1KB JSON file is the honest minimum.
 *
 * FAIL-SAFE READ (Rule 75, wrong-side): a missing file, unreadable file, or an
 * unrecognised persisted value resolves to {@link DEFAULT_PERMISSION_MODE}
 * (`manual`), NEVER to `bypass`. Corruption must degrade toward MORE gating, not
 * less — silently reading a garbled file as "no gate" would be the wrong side of
 * a vital circuit.
 */
export class FileSettingsStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /** The persisted workspace permission mode, or the safe default when unset/invalid. */
  permissionMode(): PermissionMode {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return DEFAULT_PERMISSION_MODE;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return DEFAULT_PERMISSION_MODE;
    }
    const mode = (parsed as { permissionMode?: unknown } | null)?.permissionMode;
    const result = permissionModeSchema.safeParse(mode);
    return result.success ? result.data : DEFAULT_PERMISSION_MODE;
  }

  /** Persist the workspace permission mode. Rejects an unrecognised mode. */
  setPermissionMode(mode: PermissionMode): void {
    const validated = permissionModeSchema.parse(mode);
    // Preserve any future sibling settings that already live in the file.
    let existing: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    } catch {
      existing = {};
    }
    writeFileSync(
      this.path,
      `${JSON.stringify({ ...existing, permissionMode: validated }, null, 2)}\n`,
    );
  }
}
