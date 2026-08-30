import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSnapshotStore } from "@rennet/adapters";
import type { ProjectProcessEvent } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectProcessJournal,
  type ProjectProcessJournalRecord,
  upsertProjectProcessEvent,
} from "./project-process-journal";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("project process journal", () => {
  it("round-trips the durable run and keeps one latest event per logical step", () => {
    const directory = mkdtempSync(join(tmpdir(), "rennet-project-run-"));
    directories.push(directory);
    const journal = createProjectProcessJournal(new ProjectSnapshotStore(directory));
    const runId = "77b2b81f-f58a-4869-8696-c1ef6e534ed2";
    const running: ProjectProcessEvent = {
      kind: "step",
      runId,
      repo: "rennet",
      phase: "map",
      step: "tree",
      status: "running",
      note: "Scanning the working tree",
    };
    const done: ProjectProcessEvent = {
      ...running,
      status: "done",
      detail: "456 files · 12 scopes",
    };
    const record: ProjectProcessJournalRecord = {
      version: 1,
      runId,
      projectId: "project-1",
      status: "running",
      phase: "map",
      repos: [{ repo: "rennet", path: "/repo/rennet" }],
      failures: [],
      events: upsertProjectProcessEvent(upsertProjectProcessEvent([], running), done),
    };

    journal.save("repo-key", record);

    expect(journal.load("repo-key")).toEqual({
      ...record,
      events: [done],
    });
  });

  it("treats a missing on-disk run as absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "rennet-project-run-"));
    directories.push(directory);
    const store = new ProjectSnapshotStore(directory);
    const journal = createProjectProcessJournal(store);
    expect(journal.load("missing")).toBeNull();
  });
});
