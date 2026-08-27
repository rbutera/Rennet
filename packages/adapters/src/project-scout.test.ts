import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessTurnResult } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadConventionCatalogue } from "./convention-catalogue-reader";
import type { GitExec } from "./git-range-diff";
import {
  loadScoutFacts,
  runProjectScout,
  saveScoutFacts,
  scoutDeterministic,
  scoutSettingsOffers,
} from "./project-scout";
import { ProjectSnapshotStore } from "./project-snapshot-store";

/** A canned git: answers by subcommand, rejects everything else. */
function gitStub(answers: Partial<Record<string, string>>): GitExec {
  return (_root, args) => {
    const key = args[0] === "config" ? "config" : (args[0] ?? "");
    const answer = answers[key];
    return answer === undefined ? Promise.reject(new Error(`no ${key}`)) : Promise.resolve(answer);
  };
}

const emitted = (body: unknown): HarnessTurnResult => ({ status: "emitted", body });

const dirs: string[] = [];
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "scout-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("scoutDeterministic", () => {
  it("detects GitHub from the origin remote", async () => {
    const repo = tempRepo();
    const facts = await scoutDeterministic({
      repoRoot: repo,
      git: gitStub({ config: "https://github.com/rbutera/rennet.git\n" }),
    });
    expect(facts.trackerKind?.value).toBe("github");
    expect(facts.trackerKind?.provenance).toBe("detected");
    expect(facts.trackerKind?.source).toContain("rbutera/rennet");
  });

  it("explicit JIRA markers outrank GitHub hosting; prefix is the dominant key", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "README.md"), "Track work in ABC-123 and ABC-456.");
    const facts = await scoutDeterministic({
      repoRoot: repo,
      git: gitStub({ config: "git@github.com:o/r.git", log: "fix ABC-789 widget" }),
    });
    expect(facts.trackerKind?.value).toBe("jira");
    expect(facts.trackerProjectKey?.value).toBe("ABC");
  });

  it("a linear.app link outranks the generic key shape; the prefix classifies Linear", async () => {
    const repo = tempRepo();
    // ENG-… keys are the generic ABC-123 shape Linear also uses; the explicit
    // linear.app link is the tracker-specific evidence and must win.
    writeFileSync(
      join(repo, "README.md"),
      "Work at https://linear.app/acme/team/ENG — see ENG-12 and ENG-34.",
    );
    const facts = await scoutDeterministic({
      repoRoot: repo,
      git: gitStub({ config: "git@github.com:o/r.git", log: "fix ENG-56 widget" }),
    });
    expect(facts.trackerKind?.value).toBe("linear");
    expect(facts.trackerKind?.source).toBe("linear.app link");
    expect(facts.trackerProjectKey?.value).toBe("ENG");
    expect(facts.trackerProjectKey?.provenance).toBe("detected");
  });

  it("detects the gate command from package.json scripts + lockfile", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { check: "nx check" } }));
    writeFileSync(join(repo, "pnpm-lock.yaml"), "");
    const facts = await scoutDeterministic({ repoRoot: repo, git: gitStub({}) });
    expect(facts.gateCommand?.value).toBe("pnpm check");
  });

  it("a no-signal repo yields no facts and nothing guessed", async () => {
    const facts = await scoutDeterministic({ repoRoot: tempRepo(), git: gitStub({}) });
    expect(Object.keys(facts)).toEqual([]);
  });
});

describe("runProjectScout", () => {
  it("the seat fills ONLY gaps — a detected value is never overwritten", async () => {
    const repo = tempRepo();
    const result = await runProjectScout({
      repoRoot: repo,
      git: gitStub({ config: "https://github.com/o/r.git" }),
      runTurn: () =>
        Promise.resolve(emitted({ facts: { trackerKind: "jira", gateCommand: "make test" } })),
    });
    expect(result.facts.trackerKind?.value).toBe("github");
    expect(result.facts.trackerKind?.provenance).toBe("detected");
    expect(result.facts.gateCommand?.value).toBe("make test");
    expect(result.facts.gateCommand?.provenance).toBe("guessed");
  });

  it("seeds guidance into an ABSENT catalogue only; an existing one is never touched", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "CLAUDE.md"), "# Rules\nAlways run the gate.");
    const rules = [
      {
        convention: "Run the gate before push",
        rationale: "keeps main releasable",
        severity: "high",
      },
    ];
    const seat = () => Promise.resolve(emitted({ guidanceRules: rules }));

    const first = await runProjectScout({ repoRoot: repo, git: gitStub({}), runTurn: seat });
    expect(first.guidanceSeeded).toBe(1);
    const loaded = loadConventionCatalogue(repo);
    expect(loaded.catalogue?.rules[0]?.convention).toBe("Run the gate before push");
    expect(loaded.catalogue?.source).toBe("project-scout");

    const bytes = readFileSync(join(repo, ".rennet/conventions.json"), "utf8");
    const second = await runProjectScout({ repoRoot: repo, git: gitStub({}), runTurn: seat });
    expect(second.guidanceSeeded).toBe(0);
    expect(second.guidanceSkipped).toBe("existing-catalogue");
    expect(readFileSync(join(repo, ".rennet/conventions.json"), "utf8")).toBe(bytes);
  });

  it("an unconfigured detected tracker yields a typed missing-config ask", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "README.md"), "See PROJ-1 and PROJ-2.");
    const result = await runProjectScout({ repoRoot: repo, git: gitStub({}) });
    expect(result.missingConfig).toEqual([
      expect.objectContaining({
        tracker: "jira",
        prefix: "PROJ",
        missing: "base-url-or-token-env",
      }),
    ]);
    expect(result.guidanceSkipped).toBe("no-seat");
  });
});

describe("scout persistence (amendment 9)", () => {
  it("round-trips, and only DETECTED facts become settings offers", async () => {
    const base = tempRepo();
    const store = new ProjectSnapshotStore(base);
    const repo = tempRepo();
    const result = await runProjectScout({
      repoRoot: repo,
      git: gitStub({ config: "https://github.com/o/r.git" }),
      runTurn: () => Promise.resolve(emitted({ facts: { gateCommand: "make test" } })),
    });
    saveScoutFacts(store, "esc-key", result);

    const loaded = loadScoutFacts(store, "esc-key");
    expect(loaded?.facts.trackerKind?.value).toBe("github");
    expect(loaded?.facts.gateCommand?.provenance).toBe("guessed");

    const offers = scoutSettingsOffers(store, "esc-key");
    expect(offers.trackerKind).toBe("github");
    expect(offers.gateCommand).toBeUndefined();
  });

  it("loads null for a project never scouted", () => {
    const store = new ProjectSnapshotStore(tempRepo());
    expect(loadScoutFacts(store, "missing")).toBeNull();
    expect(scoutSettingsOffers(store, "missing")).toEqual({});
  });
});
