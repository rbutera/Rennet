import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSnapshotStore } from "@rennet/adapters";
import type { ProjectProcessEvent } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectProcessJournal,
  type ProjectProcessJournalRecord,
  projectProcessJournalSchema,
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

  it("migrates a v1 journal whose questionnaires still carry the retired worktreeBaseDir answer (#812/#816 P2)", () => {
    const directory = mkdtempSync(join(tmpdir(), "rennet-project-run-"));
    directories.push(directory);
    const store = new ProjectSnapshotStore(directory);
    const journal = createProjectProcessJournal(store);
    const runId = "9a5f3c11-2b7e-4a6d-9c8f-1e2d3c4b5a60";
    // A questionnaire as v1 wrote it: FIVE answers, worktreeBaseDir among them, counts to 5.
    const legacyQuestionnaire = {
      repo: "rennet",
      answers: [
        {
          key: "trackerKind",
          value: "github",
          provenance: "detected",
          source: ".github/",
          hint: "referenced tickets feed review context",
          options: ["github", "jira", "linear", "none"],
        },
        {
          key: "defaultBranch",
          value: "main",
          provenance: "detected",
          source: "HEAD",
          hint: "the structural map reads this branch",
        },
        {
          key: "worktreeBaseDir",
          value: "../worktrees",
          provenance: "guessed",
          source: "convention",
          hint: "where this repository's own worktrees live",
        },
        {
          key: "gateCommand",
          value: "pnpm check",
          provenance: "detected",
          source: "package.json",
          hint: "coding rounds run this before handoff",
        },
        {
          key: "logoPath",
          value: "logo.png",
          provenance: "guessed",
          source: "model",
          hint: "cosmetic repository evidence only",
        },
      ],
      detected: 3,
      guessed: 2,
    };
    const legacyJournal = {
      version: 1,
      runId,
      projectId: "project-1",
      status: "done",
      phase: "complete",
      repos: [{ repo: "rennet", path: "/repo/rennet", scout: legacyQuestionnaire }],
      failures: [],
      events: [{ kind: "scout-ready", runId, repo: "rennet", questionnaire: legacyQuestionnaire }],
    };

    // Control: the current schema rejects the un-migrated journal outright. This is the
    // redden the migration answers — without it, `load` returns null and the completed run
    // silently re-scouts and re-maps (invisible model spend).
    expect(projectProcessJournalSchema.safeParse(legacyJournal).success).toBe(false);

    const projectDir = store.paths("repo-key").projectDir;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "project-process.json"), JSON.stringify(legacyJournal));

    const loaded = journal.load("repo-key");
    expect(loaded).not.toBeNull();
    // Both carriers lost the retired answer and had their counts recomputed off the four
    // survivors: three detected (tracker, branch, gate), one guessed (logo).
    const repoScout = loaded?.repos[0]?.scout;
    expect(repoScout?.answers.map((answer) => answer.key)).toEqual([
      "trackerKind",
      "defaultBranch",
      "gateCommand",
      "logoPath",
    ]);
    expect({ detected: repoScout?.detected, guessed: repoScout?.guessed }).toEqual({
      detected: 3,
      guessed: 1,
    });
    const scoutReady = loaded?.events.find((event) => event.kind === "scout-ready");
    expect(
      scoutReady?.kind === "scout-ready"
        ? scoutReady.questionnaire.answers.map((answer) => answer.key)
        : undefined,
    ).toEqual(["trackerKind", "defaultBranch", "gateCommand", "logoPath"]);
  });

  it("migrates the questionnaire a legacy done.run.scout carries (#816 re-review P2)", () => {
    const directory = mkdtempSync(join(tmpdir(), "rennet-project-run-"));
    directories.push(directory);
    const store = new ProjectSnapshotStore(directory);
    const journal = createProjectProcessJournal(store);
    const runId = "3d7c4e22-8f1a-4b3c-a2d9-6e5f4a3b2c10";
    // The scout carrier that `scout-ready`/`repos` do NOT cover: a completed run's own
    // `done.run.scout`. As v1 wrote it — FIVE answers, worktreeBaseDir among them.
    const legacyRunScout = {
      repo: "rennet",
      answers: [
        {
          key: "trackerKind",
          value: "github",
          provenance: "detected",
          source: ".github/",
          hint: "referenced tickets feed review context",
          options: ["github", "jira", "linear", "none"],
        },
        {
          key: "defaultBranch",
          value: "main",
          provenance: "detected",
          source: "HEAD",
          hint: "the structural map reads this branch",
        },
        {
          key: "worktreeBaseDir",
          value: "../worktrees",
          provenance: "guessed",
          source: "convention",
          hint: "where this repository's own worktrees live",
        },
        {
          key: "gateCommand",
          value: "pnpm check",
          provenance: "detected",
          source: "package.json",
          hint: "coding rounds run this before handoff",
        },
        {
          key: "logoPath",
          value: "logo.png",
          provenance: "guessed",
          source: "model",
          hint: "cosmetic repository evidence only",
        },
      ],
      detected: 3,
      guessed: 2,
    };
    const summary = {
      repo: "rennet",
      path: "/repo/rennet",
      ok: true,
      files: 456,
    };
    const doneEvent = {
      kind: "done",
      repos: [summary],
      run: {
        id: runId,
        projectId: "project-1",
        status: "done",
        phase: "complete",
        repos: [summary],
        scout: legacyRunScout,
        totals: { repos: 1, files: 456, scopes: 12 },
      },
    };
    const legacyJournal = {
      version: 1,
      runId,
      projectId: "project-1",
      status: "done",
      phase: "complete",
      // Repo checkpoint carries the ALREADY-current four-answer scout, so the ONLY thing
      // that can null this journal is the five-answer scout inside `done.run`.
      repos: [{ repo: "rennet", path: "/repo/rennet" }],
      failures: [],
      events: [doneEvent],
    };

    // Control: without the done.run.scout migration the current schema rejects this journal
    // (the run's scout still has five answers), so `load` would return null and re-scout.
    expect(projectProcessJournalSchema.safeParse(legacyJournal).success).toBe(false);

    const projectDir = store.paths("repo-key").projectDir;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "project-process.json"), JSON.stringify(legacyJournal));

    const loaded = journal.load("repo-key");
    expect(loaded).not.toBeNull();
    const done = loaded?.events.find((event) => event.kind === "done");
    const runScout = done?.kind === "done" ? done.run?.scout : undefined;
    expect(runScout?.answers.map((answer) => answer.key)).toEqual([
      "trackerKind",
      "defaultBranch",
      "gateCommand",
      "logoPath",
    ]);
    expect({ detected: runScout?.detected, guessed: runScout?.guessed }).toEqual({
      detected: 3,
      guessed: 1,
    });
  });
});
