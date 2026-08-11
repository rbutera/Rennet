import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GlobalConfig } from "@rennet/protocol";
import { globalConfigSchema } from "@rennet/protocol";

/**
 * The global (app-side, personal) config store — layer 1 of the settings ladder
 * (Settings and Setup Plan §1.2). A plain JSON document at `~/.rennet/config.json`,
 * last-write-wins, sibling to the local-first project snapshot store under
 * `~/.rennet/projects/`. It holds ONLY the reviewer's own machine-local
 * preferences (the scheme today); it NEVER holds a fact about a repo, and it is
 * NEVER written into a working tree — it is safe to edit with no repo materiality.
 *
 * FAIL-SAFE READ (Rule 75, wrong-side): a missing file, an unreadable file, or a
 * malformed document resolves to the empty default config (`{ version }`), never a
 * throw — a corrupt config must degrade to "all defaults", not crash the settings
 * surface. And a file we could not parse is LEFT UNTOUCHED (never rewritten from a
 * failed parse), so a human can recover it; the next `update` writes a clean shape.
 *
 * Writes are atomic: a sibling temp file is written then `rename`d over the target
 * (atomic on a single filesystem), so a reader never sees a half-written config.
 */

/** The current global-config schema version. Bumped on a breaking shape change. */
export const GLOBAL_CONFIG_VERSION = 1;

/** The default global-config path: `~/.rennet/config.json`. Tests pass a temp path. */
export function defaultGlobalConfigPath(): string {
  return join(homedir(), ".rennet", "config.json");
}

export class FileConfigStore {
  private tmpSeq = 0;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /**
   * The DISTINCT on-disk state, so a caller can tell an absent config (safe to
   * write) from a malformed one (must NOT be overwritten — Rule 75). `config` is
   * the parsed value for `ok`, and the safe default for `absent`/`malformed`.
   */
  readState(): { status: "absent" | "ok" | "malformed"; config: GlobalConfig } {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return { status: "absent", config: { version: GLOBAL_CONFIG_VERSION } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "malformed", config: { version: GLOBAL_CONFIG_VERSION } };
    }
    const result = globalConfigSchema.safeParse(parsed);
    return result.success
      ? { status: "ok", config: result.data }
      : { status: "malformed", config: { version: GLOBAL_CONFIG_VERSION } };
  }

  /** The stored config, or a fresh default when missing/unreadable/malformed. */
  read(): GlobalConfig {
    return this.readState().config;
  }

  /**
   * Read-modify-write the config atomically. The updater receives the current
   * config (or a fresh default) and returns the next one; the written config is
   * returned. Always stamps the current schema version so a legacy shape is
   * upgraded on first write.
   *
   * REFUSES to run when the on-disk file is malformed (Rule 75): overwriting
   * unparseable bytes with a default is silent data loss, so a malformed file is
   * left byte-for-byte untouched and the caller gets a thrown error to surface.
   */
  update(update: (current: GlobalConfig) => GlobalConfig): GlobalConfig {
    const state = this.readState();
    if (state.status === "malformed") {
      throw new Error(
        `refusing to overwrite a malformed config at ${this.path}; fix or remove it first`,
      );
    }
    const next = globalConfigSchema.parse({
      ...update(state.config),
      version: GLOBAL_CONFIG_VERSION,
    });
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${this.tmpSeq++}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, this.path);
    return next;
  }
}
