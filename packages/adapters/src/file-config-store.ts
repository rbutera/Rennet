import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ClientSettings, DaemonSettings, GlobalConfig } from "@rennet/protocol";
import { clientSettingsSchema, daemonSettingsSchema, globalConfigSchema } from "@rennet/protocol";
import type { ZodType } from "zod";

/**
 * The app-side settings stores — plain JSON documents under `~/.rennet/`,
 * last-write-wins, sibling to the local-first project snapshot store. B10 (#476)
 * split the single legacy `config.json` blob into two files with distinct
 * ownership:
 *   • `client-settings.json` — viewer preferences (appearance, keybindings),
 *     OUTSIDE the config ladder; the reviewer's personal machine choices.
 *   • `daemon-settings.json` — the global ladder rung as it exists on this host
 *     (the opt-in listener bind, #380).
 * Neither is ever written into a working tree — both are safe to edit with no repo
 * materiality. A legacy `config.json` v1 migrates mechanically into the two on
 * first construction (see `migrateLegacyGlobalConfig`).
 *
 * FAIL-SAFE READ (Rule 75, wrong-side): a missing file, an unreadable file, or a
 * malformed document resolves to the empty default (`{ version }`), never a throw.
 * A file we could not parse is LEFT UNTOUCHED (never rewritten from a failed
 * parse), so a human can recover it; the next `update` writes a clean shape.
 *
 * Writes are atomic: a sibling temp file is written then `rename`d over the target
 * (atomic on a single filesystem), so a reader never sees a half-written config.
 */

/** The legacy (pre-split) global-config schema version. */
export const GLOBAL_CONFIG_VERSION = 1;
/** The current client-settings schema version. Bumped on a breaking shape change. */
export const CLIENT_SETTINGS_VERSION = 1;
/** The current daemon-settings schema version. Bumped on a breaking shape change. */
export const DAEMON_SETTINGS_VERSION = 1;

/** The legacy single-blob config path, migrated FROM: `~/.rennet/config.json`. */
export function defaultGlobalConfigPath(): string {
  return join(homedir(), ".rennet", "config.json");
}
/** The client-settings path: `~/.rennet/client-settings.json`. Tests pass a temp path. */
export function defaultClientSettingsPath(): string {
  return join(homedir(), ".rennet", "client-settings.json");
}
/** The daemon-settings path: `~/.rennet/daemon-settings.json`. Tests pass a temp path. */
export function defaultDaemonSettingsPath(): string {
  return join(homedir(), ".rennet", "daemon-settings.json");
}

/** Write `value` to `path` atomically (sibling temp + rename), pretty JSON + newline. */
function atomicWrite(path: string, value: unknown, tmpTag: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${tmpTag}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * An atomic, fail-safe JSON store for one versioned settings document. Generic over
 * the document shape so the client and daemon stores share one implementation —
 * they differ only in path, schema, and version.
 */
export class FileConfigStore<T extends { version: number }> {
  private tmpSeq = 0;
  private readonly fresh: T;

  constructor(
    private readonly path: string,
    private readonly schema: ZodType<T>,
    private readonly version: number,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    // `{ version }` is a valid, all-defaults document for every settings schema.
    this.fresh = schema.parse({ version });
  }

  /**
   * The DISTINCT on-disk state, so a caller can tell an absent config (safe to
   * write) from a malformed one (must NOT be overwritten — Rule 75). `config` is
   * the parsed value for `ok`, and the safe default for `absent`/`malformed`.
   */
  readState(): { status: "absent" | "ok" | "malformed"; config: T } {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return { status: "absent", config: this.fresh };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "malformed", config: this.fresh };
    }
    const result = this.schema.safeParse(parsed);
    return result.success
      ? { status: "ok", config: result.data }
      : { status: "malformed", config: this.fresh };
  }

  /** The stored config, or a fresh default when missing/unreadable/malformed. */
  read(): T {
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
  update(update: (current: T) => T): T {
    const state = this.readState();
    if (state.status === "malformed") {
      throw new Error(
        `refusing to overwrite a malformed config at ${this.path}; fix or remove it first`,
      );
    }
    const next = this.schema.parse({ ...update(state.config), version: this.version });
    atomicWrite(this.path, next, String(this.tmpSeq++));
    return next;
  }
}

/** Construct the client-settings store (viewer preferences). */
export function createClientSettingsStore(path: string): FileConfigStore<ClientSettings> {
  return new FileConfigStore(path, clientSettingsSchema, CLIENT_SETTINGS_VERSION);
}

/** Construct the daemon-settings store (the host's global ladder rung). */
export function createDaemonSettingsStore(path: string): FileConfigStore<DaemonSettings> {
  return new FileConfigStore(path, daemonSettingsSchema, DAEMON_SETTINGS_VERSION);
}

/**
 * Mechanically migrate a legacy `config.json` v1 blob into the split
 * `client-settings.json` + `daemon-settings.json` (B10 #476). ONE-WAY and
 * DETERMINISTIC: viewer prefs (`appearance`, `keybindings`) go to client-settings,
 * the host rung (`daemon`) to daemon-settings, every field lands in exactly one
 * target and nothing is dropped. The legacy file is LEFT IN PLACE (a human may
 * still want it); re-migration is prevented by the split-file guard, so this is
 * provably idempotent: a second call sees a split file already present and no-ops.
 *
 * Runs only when there is something to migrate and nothing already migrated:
 *   • either split file already exists ⇒ already migrated, no-op.
 *   • legacy file absent or malformed ⇒ nothing to migrate (fresh/broken install);
 *     the stores' fail-safe read handles those.
 */
export function migrateLegacyGlobalConfig(paths: {
  legacyPath: string;
  clientPath: string;
  daemonPath: string;
}): { migrated: boolean } {
  if (existsSync(paths.clientPath) || existsSync(paths.daemonPath)) return { migrated: false };

  let legacy: GlobalConfig;
  try {
    const parsed = globalConfigSchema.safeParse(JSON.parse(readFileSync(paths.legacyPath, "utf8")));
    if (!parsed.success) return { migrated: false };
    legacy = parsed.data;
  } catch {
    return { migrated: false };
  }

  const client: ClientSettings = { version: CLIENT_SETTINGS_VERSION };
  if (legacy.appearance !== undefined) client.appearance = legacy.appearance;
  if (legacy.keybindings !== undefined) client.keybindings = legacy.keybindings;

  const daemon: DaemonSettings = { version: DAEMON_SETTINGS_VERSION };
  if (legacy.daemon !== undefined) daemon.daemon = legacy.daemon;

  // Validate both targets before writing either, then write atomically.
  atomicWrite(paths.clientPath, clientSettingsSchema.parse(client), "client");
  atomicWrite(paths.daemonPath, daemonSettingsSchema.parse(daemon), "daemon");
  return { migrated: true };
}
