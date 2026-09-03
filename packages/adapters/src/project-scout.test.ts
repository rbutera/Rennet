import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HarnessTurnResult, inlineContextViolation } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadConventionCatalogue } from "./convention-catalogue-reader";
import type { GitExec } from "./git-range-diff";
import {
  loadScoutFacts,
  PROJECT_SCOUT_CONTEXT_ID,
  resolveTrackerConfig,
  runProjectScout,
  SCOUT_DETECTED_FILE,
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
  it("emits deterministic boundaries before guidance and returns a total five-answer floor", async () => {
    const progress: import("./project-scout").ProjectScoutProgress[] = [];
    const result = await runProjectScout({
      repoRoot: tempRepo(),
      git: gitStub({}),
      knownDefaultBranch: "trunk",
      runTurn: null,
      onProgress: (event) => progress.push(event),
    });

    expect(progress.map((event) => `${event.step}:${event.status}`)).toEqual([
      "remotes:running",
      "remotes:done",
      "config:running",
      "config:done",
      "guidance:running",
      "guidance:done",
    ]);
    expect(result.facts.defaultBranch).toEqual({
      value: "trunk",
      provenance: "detected",
      source: "confirmed during project discovery",
    });
    expect(result.facts).toMatchObject({
      trackerKind: { value: "none", provenance: "guessed" },
      worktreeBaseDir: { value: "~/.rennet/worktrees", provenance: "guessed" },
      gateCommand: { value: "", provenance: "guessed" },
      logoPath: { value: "", provenance: "guessed" },
    });
  });

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

  // ── session-context-files 3.8: the prompt names files, it never carries them ──

  /** A guidance document the size real ones are — 12 kB used to ride every scout prompt. */
  function bigGuidance(marker: string): string {
    return `# ${marker}\n${`${marker} paragraph of repository guidance.\n`.repeat(400)}`;
  }

  it("names the guidance documents by path and embeds none of their bytes", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "CLAUDE.md"), bigGuidance("CLAUDE-SENTINEL"));
    writeFileSync(join(repo, "AGENTS.md"), bigGuidance("AGENTS-SENTINEL"));
    writeFileSync(join(repo, "CONTRIBUTING.md"), bigGuidance("CONTRIBUTING-SENTINEL"));
    let prompt = "";
    await runProjectScout({
      repoRoot: repo,
      git: gitStub({}),
      runTurn: (sent) => {
        prompt = sent;
        return Promise.resolve(emitted({}));
      },
    });

    // Every present document is named…
    expect(prompt).toContain("CONTRIBUTING.md");
    expect(prompt).toContain("CLAUDE.md");
    expect(prompt).toContain("AGENTS.md");
    // …and not one byte of any of them travelled.
    expect(prompt).not.toContain("CLAUDE-SENTINEL");
    expect(prompt).not.toContain("AGENTS-SENTINEL");
    expect(prompt).not.toContain("CONTRIBUTING-SENTINEL");
    expect(inlineContextViolation(prompt)).toBeUndefined();
    // A bound, not a vibe: the same three documents used to add ~24 kB here.
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(1_200);
  });

  it("writes the detected facts to scout-detected.json and names its relative path", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "README.md"), "Track work in ABC-1 and ABC-2.");
    writeFileSync(join(repo, "CLAUDE.md"), bigGuidance("CLAUDE-SENTINEL"));
    const written: { name: string; body: string; holds: string; readWhen: string }[] = [];
    let prompt = "";
    await runProjectScout({
      repoRoot: repo,
      git: gitStub({}),
      writeContext: (files) => {
        written.push(...files);
        return join(repo, ".rennet", "context", PROJECT_SCOUT_CONTEXT_ID);
      },
      runTurn: (sent) => {
        prompt = sent;
        return Promise.resolve(emitted({}));
      },
    });

    expect(written).toHaveLength(1);
    const file = written[0];
    expect(file?.name).toBe(SCOUT_DETECTED_FILE);
    // The detected facts are in the FILE, with the two index lines the writer needs.
    expect(JSON.parse(file?.body ?? "null")).toMatchObject({
      trackerKind: { value: "jira", provenance: "detected" },
      trackerProjectKey: { value: "ABC" },
    });
    expect(file?.holds).not.toBe("");
    expect(file?.readWhen).not.toBe("");
    // The prompt names the path, relative to the cwd the seat runs in, and nothing else.
    expect(prompt).toContain(`.rennet/context/${PROJECT_SCOUT_CONTEXT_ID}/${SCOUT_DETECTED_FILE}`);
    expect(prompt).not.toContain('"provenance"');
    expect(inlineContextViolation(prompt)).toBeUndefined();
  });

  it("skipping the context write leaves the prompt with no path to name (the control)", async () => {
    // The control for the test above, executed rather than described: drop the writer and
    // the path assertion has nothing to match, which is what makes it load-bearing.
    const repo = tempRepo();
    writeFileSync(join(repo, "README.md"), "Track work in ABC-1 and ABC-2.");
    let prompt = "";
    await runProjectScout({
      repoRoot: repo,
      git: gitStub({}),
      runTurn: (sent) => {
        prompt = sent;
        return Promise.resolve(emitted({}));
      },
    });
    expect(prompt).not.toContain(SCOUT_DETECTED_FILE);
    expect(prompt).not.toContain("already detected");
    // Still a usable prompt: the gaps are still named, so the seat still has its job.
    expect(prompt).toContain("Fill ONLY these unknown facts");
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

  it("a malformed persisted record is an honest absence, never trusted typed data", () => {
    const store = new ProjectSnapshotStore(tempRepo());
    // A hand-edited file with an out-of-vocabulary provenance must not walk
    // into the settings ladder — schema-parse, never cast.
    mkdirSync(store.paths("forged").projectDir, { recursive: true });
    writeFileSync(
      join(store.paths("forged").projectDir, "scout.json"),
      JSON.stringify({
        facts: { trackerKind: { value: "jira", provenance: "definitely-detected", source: "x" } },
      }),
    );
    expect(loadScoutFacts(store, "forged")).toBeNull();
    expect(scoutSettingsOffers(store, "forged")).toEqual({});
  });
});

describe("resolveTrackerConfig — the ladder-resolved retrieval config (#461, B7)", () => {
  const detectedJira = (store: ProjectSnapshotStore, repoKey: string): void => {
    saveScoutFacts(store, repoKey, {
      facts: {
        trackerKind: { value: "jira", provenance: "detected", source: "README badge" },
        trackerProjectKey: { value: "PROJ", provenance: "detected", source: "commit subjects" },
      },
      guidanceSeeded: 0,
      missingConfig: [],
    });
  };

  it("detected kind + prefix under global endpoint config yields a routed endpoint", () => {
    const store = new ProjectSnapshotStore(tempRepo());
    detectedJira(store, "esc");
    const config = resolveTrackerConfig(store, "esc", {
      version: 1,
      tracker: { baseUrl: "https://jira.example", tokenEnv: "JIRA_TOKEN" },
    });
    expect(config).toEqual({
      jira: {
        baseUrl: "https://jira.example",
        tokenEnvVar: "JIRA_TOKEN",
        projectPrefixes: ["PROJ"],
      },
    });
  });

  it("an incomplete endpoint resolves to undefined — missing-config facts downstream, never a gate", () => {
    const store = new ProjectSnapshotStore(tempRepo());
    detectedJira(store, "esc");
    expect(resolveTrackerConfig(store, "esc", { version: 1 })).toBeUndefined();
  });

  it("the global rung outranks the detected offer (specificity wins)", () => {
    const store = new ProjectSnapshotStore(tempRepo());
    detectedJira(store, "esc");
    const config = resolveTrackerConfig(store, "esc", {
      version: 1,
      tracker: {
        kind: "linear",
        projectKey: "ENG",
        baseUrl: "https://api.linear.app",
        tokenEnv: "LINEAR_TOKEN",
      },
    });
    expect(config).toEqual({
      linear: {
        baseUrl: "https://api.linear.app",
        tokenEnvVar: "LINEAR_TOKEN",
        projectPrefixes: ["ENG"],
      },
    });
  });

  // The retrieval-REACHABILITY controls (C18 group A). Before the repo rung existed,
  // a "per-project tracker" could only ever be the host's global answer — so these
  // are the checks that fail if a per-project write stops reaching retrieval.
  const globalLinear = {
    version: 1,
    tracker: {
      kind: "linear",
      projectKey: "ENG",
      baseUrl: "https://api.linear.app",
      tokenEnv: "LINEAR_TOKEN",
    },
  } as const;

  it("a project's own repo rung outranks the global one — and moves ONLY that project", () => {
    const store = new ProjectSnapshotStore(tempRepo());
    store.updateConfig("with-override", (current) => ({
      ...current,
      tracker: {
        kind: "jira",
        projectKey: "PAY",
        baseUrl: "https://pay.atlassian.net",
        tokenEnv: "PAY_JIRA_TOKEN",
      },
    }));
    expect(resolveTrackerConfig(store, "with-override", globalLinear)).toEqual({
      jira: {
        baseUrl: "https://pay.atlassian.net",
        tokenEnvVar: "PAY_JIRA_TOKEN",
        projectPrefixes: ["PAY"],
      },
    });
    // The sibling project, untouched, still resolves the host's global answer.
    expect(resolveTrackerConfig(store, "sibling", globalLinear)).toEqual({
      linear: {
        baseUrl: "https://api.linear.app",
        tokenEnvVar: "LINEAR_TOKEN",
        projectPrefixes: ["ENG"],
      },
    });
  });

  it("a repo kind NEVER inherits the lower rung's credentials — no JIRA call with a Linear token", () => {
    const store = new ProjectSnapshotStore(tempRepo());
    // The exact repro: the project chose JIRA on its own rung; the host's global rung
    // holds LINEAR endpoint config. Resolving key-by-key produced a `jira` endpoint
    // carrying `api.linear.app` + `LINEAR_TOKEN` — a real cross-provider call.
    store.updateConfig("mixed", (current) => ({ ...current, tracker: { kind: "jira" } }));
    // Masked, so the endpoint is INCOMPLETE: no config beats wrong config. Retrieval
    // proceeds and the missing keys surface as missing-config facts (never a gate).
    expect(resolveTrackerConfig(store, "mixed", globalLinear)).toBeUndefined();

    // Supplying the JIRA endpoint on the SAME rung as the kind resolves normally.
    store.updateConfig("mixed", (current) => ({
      ...current,
      tracker: {
        kind: "jira",
        baseUrl: "https://pay.atlassian.net",
        tokenEnv: "PAY_JIRA_TOKEN",
      },
    }));
    expect(resolveTrackerConfig(store, "mixed", globalLinear)).toEqual({
      jira: { baseUrl: "https://pay.atlassian.net", tokenEnvVar: "PAY_JIRA_TOKEN" },
    });
  });

  it("an endpoint field ABOVE the kind's rung refines it — same provider, narrower answer", () => {
    const store = new ProjectSnapshotStore(tempRepo());
    // The host set the kind AND its endpoint; the project only narrows the prefix.
    store.updateConfig("refined", (current) => ({
      ...current,
      tracker: { projectKey: "ENG-PLATFORM" },
    }));
    expect(resolveTrackerConfig(store, "refined", globalLinear)).toEqual({
      linear: {
        baseUrl: "https://api.linear.app",
        tokenEnvVar: "LINEAR_TOKEN",
        projectPrefixes: ["ENG-PLATFORM"],
      },
    });
  });

  it("an untouched install reads the global defaults — the repo rung offers nothing", () => {
    const store = new ProjectSnapshotStore(tempRepo());
    expect(store.loadConfig("untouched")).toBeNull();
    expect(resolveTrackerConfig(store, "untouched", globalLinear)).toEqual({
      linear: {
        baseUrl: "https://api.linear.app",
        tokenEnvVar: "LINEAR_TOKEN",
        projectPrefixes: ["ENG"],
      },
    });
  });

  it("a malformed project config never leaks an override into retrieval", () => {
    const store = new ProjectSnapshotStore(tempRepo());
    const paths = store.paths("broken");
    mkdirSync(paths.projectDir, { recursive: true });
    writeFileSync(paths.configPath, '{"version":1,"tracker":{"kind":7}}');
    expect(store.loadConfigState("broken").status).toBe("malformed");
    expect(resolveTrackerConfig(store, "broken", globalLinear)).toEqual({
      linear: {
        baseUrl: "https://api.linear.app",
        tokenEnvVar: "LINEAR_TOKEN",
        projectPrefixes: ["ENG"],
      },
    });
    // …and the malformed file REFUSES the next write rather than being overwritten.
    expect(() => store.updateConfig("broken", (current) => current)).toThrow(/malformed/);
  });
});
