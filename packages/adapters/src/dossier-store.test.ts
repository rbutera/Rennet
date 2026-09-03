import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeDossier } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DossierStore } from "./dossier-store";
import { ProjectSnapshotStore } from "./project-snapshot-store";

const item = (id: string) => ({
  id,
  tracker: "github",
  title: `Title ${id}`,
  state: "open",
  body: "body",
  url: `https://github.com/x/y/issues/1`,
  provenance: "pr-body",
  fetchedAt: "2026-08-27T12:00:00.000Z",
});

describe("DossierStore", () => {
  const dirs: string[] = [];
  const freshBase = () => {
    const dir = mkdtempSync(join(tmpdir(), "b07-dossier-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips: write → fresh read → identical serializeDossier bytes", () => {
    const base = freshBase();
    const key = { target: "pr-489", patchsetRef: "abc1234" };
    const items = [item("github:x/y#2"), item("github:x/y#1")];
    const raw = [{ id: "github:x/y#1", tracker: "github", payload: { full: "thread" } }];

    new DossierStore(new ProjectSnapshotStore(base)).save("repo-key", key, items, raw);

    const fresh = new DossierStore(new ProjectSnapshotStore(base));
    const loaded = fresh.load("repo-key", key);
    expect(loaded).not.toBeNull();
    expect(serializeDossier(loaded ?? [])).toBe(serializeDossier(items));
    expect(fresh.loadRaw("repo-key", key)).toEqual(raw);
  });

  it("reads absence and a foreign key as null, never a throw", () => {
    const store = new DossierStore(new ProjectSnapshotStore(freshBase()));
    expect(store.load("repo-key", { target: "pr-1", patchsetRef: "x" })).toBeNull();
    expect(store.loadRaw("repo-key", { target: "pr-1", patchsetRef: "x" })).toBeNull();
  });

  it("publishes dossier + raw as ONE record: both present or both null", () => {
    const base = freshBase();
    const key = { target: "pr-489", patchsetRef: "abc1234" };
    const store = new DossierStore(new ProjectSnapshotStore(base));
    store.save("repo-key", key, [item("github:x/y#1")], []);
    // The single-envelope publish means a loadable dossier ALWAYS has its raw
    // side (empty here, but present) — no torn pair to observe.
    expect(store.load("repo-key", key)).not.toBeNull();
    expect(store.loadRaw("repo-key", key)).toEqual([]);
  });

  it("rejects a malformed persisted record as an honest absence, not typed data", () => {
    const base = freshBase();
    const key = { target: "pr-489", patchsetRef: "abc1234" };
    const snapshotStore = new ProjectSnapshotStore(base);
    const store = new DossierStore(snapshotStore);
    store.save("repo-key", key, [item("github:x/y#1")], []);

    // Corrupt the record: raw entries missing required fields must not come
    // back as RawContextPayload[] via a cast.
    const dossierDir = join(snapshotStore.paths("repo-key").projectDir, "dossier");
    const segment = readdirSync(dossierDir)[0] ?? "";
    writeFileSync(
      join(dossierDir, segment, "record.json"),
      JSON.stringify({ dossier: "[]", raw: [{ forged: true }] }),
    );
    expect(store.loadRaw("repo-key", key)).toBeNull();
    expect(store.load("repo-key", key)).toBeNull();
  });
});
