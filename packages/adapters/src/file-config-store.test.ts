import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_SETTINGS_VERSION,
  createClientSettingsStore,
  createDaemonSettingsStore,
  DAEMON_SETTINGS_VERSION,
  migrateLegacyGlobalConfig,
} from "./file-config-store";

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rennet-config-"));
  dirs.push(dir);
  return dir;
}
function tmpConfigPath(): string {
  return join(tmpDir(), "client-settings.json");
}

afterEach(() => {
  dirs.length = 0;
});

describe("FileConfigStore (client settings)", () => {
  it("reads the default config when the file is absent", () => {
    const store = createClientSettingsStore(tmpConfigPath());
    expect(store.read()).toEqual({ version: CLIENT_SETTINGS_VERSION });
  });

  it("persists an appearance scheme and reads it back", () => {
    const path = tmpConfigPath();
    const store = createClientSettingsStore(path);
    const written = store.update((current) => ({ ...current, appearance: { scheme: "light" } }));
    expect(written.appearance?.scheme).toBe("light");
    // A fresh store over the same path sees the persisted value (durability).
    expect(createClientSettingsStore(path).read().appearance?.scheme).toBe("light");
  });

  it("refuses an UNSUPPORTED version doc rather than silently re-stamping it (finding 6)", () => {
    // A future (v2) doc must NOT be read as v1 and re-stamped — that strips every
    // field this version does not know and destroys the newer doc's data. The
    // version literal makes it read as malformed, and update refuses it.
    const path = tmpConfigPath();
    const future = JSON.stringify({ version: 2, appearance: { scheme: "dark" }, unknownV2: 1 });
    writeFileSync(path, future);
    const store = createClientSettingsStore(path);
    expect(store.readState().status).toBe("malformed");
    expect(() =>
      store.update((current) => ({ ...current, appearance: { scheme: "light" } })),
    ).toThrow(/malformed/);
    // The v2 bytes are left byte-identical — no destructive down-migration.
    expect(readFileSync(path, "utf8")).toBe(future);
  });

  it("degrades a malformed JSON file to defaults WITHOUT rewriting it (Rule 75, wrong-side)", () => {
    const path = tmpConfigPath();
    writeFileSync(path, "{ this is not json");
    const store = createClientSettingsStore(path);
    expect(store.read()).toEqual({ version: CLIENT_SETTINGS_VERSION });
    // The unparseable file is left untouched so a human can recover it.
    expect(readFileSync(path, "utf8")).toBe("{ this is not json");
  });

  it("degrades a well-formed-but-invalid document to defaults", () => {
    const path = tmpConfigPath();
    writeFileSync(
      path,
      JSON.stringify({ version: "not-a-number", appearance: { scheme: "chartreuse" } }),
    );
    expect(createClientSettingsStore(path).read()).toEqual({ version: CLIENT_SETTINGS_VERSION });
  });

  it("reports distinct absent / ok / malformed states", () => {
    const path = tmpConfigPath();
    const store = createClientSettingsStore(path);
    expect(store.readState().status).toBe("absent");
    store.update((current) => ({ ...current, appearance: { scheme: "dark" } }));
    expect(store.readState().status).toBe("ok");
    writeFileSync(path, "{ broken");
    expect(store.readState().status).toBe("malformed");
  });

  it("REFUSES to overwrite a malformed config, leaving the bytes byte-identical (Rule 75 regression)", () => {
    const path = tmpConfigPath();
    const malformed = '{ "version": 1, "appearance": { "scheme": "dark" '; // truncated, unparseable
    writeFileSync(path, malformed);
    const store = createClientSettingsStore(path);
    // An attempted edit throws rather than silently discarding the unparseable file.
    expect(() =>
      store.update((current) => ({ ...current, appearance: { scheme: "light" } })),
    ).toThrow(/malformed/);
    // The malformed file is still exactly as it was — nothing was written over it.
    expect(readFileSync(path, "utf8")).toBe(malformed);
  });
});

describe("FileConfigStore (daemon settings)", () => {
  it("persists and reads back the listener bind", () => {
    const path = join(tmpDir(), "daemon-settings.json");
    const store = createDaemonSettingsStore(path);
    expect(store.read()).toEqual({ version: DAEMON_SETTINGS_VERSION });
    store.update((current) => ({
      ...current,
      daemon: { listen: { host: "100.64.0.1", port: 4321 } },
    }));
    expect(createDaemonSettingsStore(path).read().daemon?.listen).toEqual({
      host: "100.64.0.1",
      port: 4321,
    });
  });
});

describe("migrateLegacyGlobalConfig", () => {
  // A v1 fixture with EVERY migratable field set: viewer prefs (appearance,
  // keybindings) and the host rung (daemon). The round-trip below fails if any
  // one of these is dropped or routed to the wrong file — that IS the positive
  // control (remove a mapping in the migration and this deep-equal breaks).
  const legacyFixture: GlobalConfig = {
    version: 1,
    appearance: { scheme: "dark" },
    keybindings: { "review.openPr": "mod+o", "projects.add": null },
    daemon: { listen: { host: "100.64.0.1", port: 4321 } },
    // The B7 tracker section (#461): a GLOBAL-rung host fact that migrates into
    // daemon-settings. Its presence here makes this the FULL current-main v1 shape;
    // drop the migration mapping and the round-trip deep-equal breaks.
    tracker: { kind: "github", projectKey: "rbutera/rennet", tokenEnv: "RENNET_TRACKER_TOKEN" },
  };

  function seed(): { legacyPath: string; clientPath: string; daemonPath: string } {
    const dir = tmpDir();
    const legacyPath = join(dir, "config.json");
    writeFileSync(legacyPath, JSON.stringify(legacyFixture, null, 2));
    return {
      legacyPath,
      clientPath: join(dir, "client-settings.json"),
      daemonPath: join(dir, "daemon-settings.json"),
    };
  }

  it("splits a legacy v1 blob losslessly into the two files (round-trip)", () => {
    const paths = seed();
    expect(migrateLegacyGlobalConfig(paths).migrated).toBe(true);

    const client = createClientSettingsStore(paths.clientPath).read();
    const daemon = createDaemonSettingsStore(paths.daemonPath).read();

    // Reconstruct the legacy shape from the two split files and prove NOTHING was
    // dropped: every field is present, in the correct target, byte-for-byte.
    const reconstructed: GlobalConfig = {
      version: 1,
      ...(client.appearance ? { appearance: client.appearance } : {}),
      ...(client.keybindings ? { keybindings: client.keybindings } : {}),
      ...(daemon.daemon ? { daemon: daemon.daemon } : {}),
      ...(daemon.tracker ? { tracker: daemon.tracker } : {}),
    };
    expect(reconstructed).toEqual(legacyFixture);
    // The correct-file assertion: the daemon rung is NOT in client settings, and
    // the viewer prefs are NOT in daemon settings.
    expect((client as GlobalConfig).daemon).toBeUndefined();
    expect((client as GlobalConfig).tracker).toBeUndefined();
    expect((daemon as GlobalConfig).appearance).toBeUndefined();
    expect((daemon as GlobalConfig).keybindings).toBeUndefined();
  });

  it("is idempotent: a second run no-ops (split files already present)", () => {
    const paths = seed();
    expect(migrateLegacyGlobalConfig(paths).migrated).toBe(true);
    const clientBytes = readFileSync(paths.clientPath, "utf8");
    const daemonBytes = readFileSync(paths.daemonPath, "utf8");
    // Even with the legacy file still on disk, re-running changes nothing.
    expect(migrateLegacyGlobalConfig(paths).migrated).toBe(false);
    expect(readFileSync(paths.clientPath, "utf8")).toBe(clientBytes);
    expect(readFileSync(paths.daemonPath, "utf8")).toBe(daemonBytes);
  });

  it("no-ops when the legacy file is absent (fresh install)", () => {
    const dir = tmpDir();
    const paths = {
      legacyPath: join(dir, "config.json"),
      clientPath: join(dir, "client-settings.json"),
      daemonPath: join(dir, "daemon-settings.json"),
    };
    expect(migrateLegacyGlobalConfig(paths).migrated).toBe(false);
    expect(existsSync(paths.clientPath)).toBe(false);
    expect(existsSync(paths.daemonPath)).toBe(false);
  });

  it("reports a malformed legacy file as DISTINCT from absent, migrating nothing (finding 5, Rule 75)", () => {
    const dir = tmpDir();
    const legacyPath = join(dir, "config.json");
    writeFileSync(legacyPath, "{ not json");
    const paths = {
      legacyPath,
      clientPath: join(dir, "client-settings.json"),
      daemonPath: join(dir, "daemon-settings.json"),
    };
    const result = migrateLegacyGlobalConfig(paths);
    expect(result.migrated).toBe(false);
    // Corrupt is never collapsed into the fresh-install (absent) case.
    expect(result.legacy).toBe("malformed");
    expect(existsSync(paths.clientPath)).toBe(false);
    expect(existsSync(paths.daemonPath)).toBe(false);
    expect(readFileSync(legacyPath, "utf8")).toBe("{ not json");
  });

  it("reconciles a MISSING half after a partial prior write, never overwriting the present one (finding 4)", () => {
    const paths = seed();
    // Simulate a crashed first run: client half written, daemon write never landed.
    writeFileSync(
      paths.clientPath,
      JSON.stringify({ version: 1, appearance: { scheme: "light" } }),
    );
    const clientBytesBefore = readFileSync(paths.clientPath, "utf8");

    // Next launch: the daemon half is still absent, so it migrates from the legacy
    // blob; the already-present client half is left byte-for-byte untouched.
    const result = migrateLegacyGlobalConfig(paths);
    expect(result.migrated).toBe(true);
    expect(readFileSync(paths.clientPath, "utf8")).toBe(clientBytesBefore);
    const daemon = createDaemonSettingsStore(paths.daemonPath).read();
    expect(daemon.daemon?.listen).toEqual({ host: "100.64.0.1", port: 4321 });
    expect(daemon.tracker?.kind).toBe("github");
  });

  it("refuses to down-migrate a v2 legacy blob (finding 6): nothing written, bytes untouched", () => {
    const dir = tmpDir();
    const legacyPath = join(dir, "config.json");
    const futureBlob = JSON.stringify({ version: 2, tracker: { kind: "github" }, unknownV2: true });
    writeFileSync(legacyPath, futureBlob);
    const paths = {
      legacyPath,
      clientPath: join(dir, "client-settings.json"),
      daemonPath: join(dir, "daemon-settings.json"),
    };
    const result = migrateLegacyGlobalConfig(paths);
    expect(result.migrated).toBe(false);
    expect(result.legacy).toBe("malformed");
    expect(existsSync(paths.clientPath)).toBe(false);
    expect(existsSync(paths.daemonPath)).toBe(false);
    expect(readFileSync(legacyPath, "utf8")).toBe(futureBlob);
  });

  it("REFUSES to overwrite a v2 split file on update (finding 6)", () => {
    const dir = tmpDir();
    const daemonPath = join(dir, "daemon-settings.json");
    const futureDoc = JSON.stringify({ version: 2, daemon: { listen: { host: "::1" } }, next: 1 });
    writeFileSync(daemonPath, futureDoc);
    const store = createDaemonSettingsStore(daemonPath);
    expect(store.readState().status).toBe("malformed");
    expect(() => store.update((current) => current)).toThrow(/malformed/);
    expect(readFileSync(daemonPath, "utf8")).toBe(futureDoc);
  });
});
