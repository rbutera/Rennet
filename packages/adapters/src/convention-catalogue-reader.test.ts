import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONVENTIONS_FILE,
  loadConventionCatalogue,
  saveConventionCatalogue,
} from "./convention-catalogue-reader";

/** A temp project root; optionally seed `.rennet/conventions.json` with `content`. */
function tempProject(content?: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "rennet-conventions-"));
  if (content !== undefined) {
    const file = join(root, CONVENTIONS_FILE);
    mkdirSync(join(root, ".rennet"), { recursive: true });
    writeFileSync(file, content);
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

const VALID_RULE = {
  id: "arch-boundary",
  convention: "file I/O lives only in adapters",
  rationale: "the core package must stay pure",
  severity: "high",
  antiPattern: "importing node:fs from core",
};

describe("loadConventionCatalogue (#180) — honest degradation over an optional file", () => {
  it("returns `absent` with no catalogue when the file does not exist", () => {
    const { root, cleanup } = tempProject();
    try {
      const load = loadConventionCatalogue(root);
      expect(load.catalogue).toBeUndefined();
      expect(load.reason).toBe("absent");
      expect(load.dropped).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("loads a valid catalogue and defaults `source` to the file path", () => {
    const { root, cleanup } = tempProject(JSON.stringify({ rules: [VALID_RULE] }));
    try {
      const load = loadConventionCatalogue(root);
      expect(load.reason).toBeUndefined();
      expect(load.dropped).toBe(0);
      expect(load.catalogue?.rules).toHaveLength(1);
      const rule = load.catalogue?.rules[0];
      expect(rule?.convention).toBe("file I/O lives only in adapters");
      expect(rule?.rationale).toBe("the core package must stay pure");
      expect(rule?.severity).toBe("high");
      expect(rule?.antiPattern).toBe("importing node:fs from core");
      expect(rule?.id).toBe("arch-boundary");
      expect(load.catalogue?.source).toBe(join(root, CONVENTIONS_FILE));
    } finally {
      cleanup();
    }
  });

  it("honours an explicit `source` when the file provides one", () => {
    const { root, cleanup } = tempProject(
      JSON.stringify({ source: "team handbook §4", rules: [VALID_RULE] }),
    );
    try {
      expect(loadConventionCatalogue(root).catalogue?.source).toBe("team handbook §4");
    } finally {
      cleanup();
    }
  });

  it("accepts a bare array of rules", () => {
    const { root, cleanup } = tempProject(JSON.stringify([VALID_RULE]));
    try {
      const load = loadConventionCatalogue(root);
      expect(load.catalogue?.rules).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("drops malformed rules itemwise and keeps the valid ones", () => {
    const { root, cleanup } = tempProject(
      JSON.stringify({
        rules: [
          VALID_RULE,
          { convention: "", rationale: "blank convention", severity: "low" },
          { convention: "no rationale here", severity: "low" },
          { convention: "bad severity", rationale: "why", severity: "critical" },
          { convention: "ok two", rationale: "why two", severity: "low" },
        ],
      }),
    );
    try {
      const load = loadConventionCatalogue(root);
      expect(load.catalogue?.rules).toHaveLength(2);
      expect(load.dropped).toBe(3);
      expect(load.reason).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("returns `no-valid-rules` when rules are present but all malformed", () => {
    const { root, cleanup } = tempProject(
      JSON.stringify({ rules: [{ convention: "x" }, { severity: "high" }] }),
    );
    try {
      const load = loadConventionCatalogue(root);
      expect(load.catalogue).toBeUndefined();
      expect(load.reason).toBe("no-valid-rules");
      expect(load.dropped).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("returns `empty` for an empty rules array", () => {
    const { root, cleanup } = tempProject(JSON.stringify({ rules: [] }));
    try {
      const load = loadConventionCatalogue(root);
      expect(load.catalogue).toBeUndefined();
      expect(load.reason).toBe("empty");
    } finally {
      cleanup();
    }
  });

  it("returns `unreadable` for a garbled JSON file rather than throwing", () => {
    const { root, cleanup } = tempProject("{ this is not json");
    try {
      const load = loadConventionCatalogue(root);
      expect(load.catalogue).toBeUndefined();
      expect(load.reason).toBe("unreadable");
    } finally {
      cleanup();
    }
  });
});

describe("saveConventionCatalogue (C18) — the writer beside the reader", () => {
  it("round-trips an edit: an existing rule keeps its rationale, a new one states its own", () => {
    const { root, cleanup } = tempProject(JSON.stringify({ rules: [VALID_RULE] }));
    try {
      const written = saveConventionCatalogue(root, [
        { convention: VALID_RULE.convention, severity: "low" },
        { convention: "prefer nx affected on a branch", severity: "medium" },
      ]);
      expect(written.catalogue?.rules).toEqual([
        {
          id: "arch-boundary",
          convention: VALID_RULE.convention,
          // The severity edit landed; the authored rationale + anti-pattern survived it.
          rationale: "the core package must stay pure",
          severity: "low",
          antiPattern: "importing node:fs from core",
        },
        {
          convention: "prefer nx affected on a branch",
          rationale: "prefer nx affected on a branch",
          severity: "medium",
        },
      ]);
      // The FILE is what changed — a re-read (a reload) sees the same rules.
      expect(loadConventionCatalogue(root).catalogue?.rules).toEqual(written.catalogue?.rules);
    } finally {
      cleanup();
    }
  });

  it("RETYPING a rule keeps its id, rationale and anti-pattern — identity, not text, addresses it", () => {
    const { root, cleanup } = tempProject(
      JSON.stringify({ source: "the team handbook", rules: [VALID_RULE] }),
    );
    try {
      // The exact clobber: the statement is rewritten, so a text match finds nothing and
      // the rule was rebuilt from scratch — losing id, rationale and anti-pattern.
      const written = saveConventionCatalogue(root, [
        { id: VALID_RULE.id, convention: "file I/O belongs in adapters only", severity: "high" },
      ]);
      expect(written.catalogue?.rules).toEqual([
        {
          id: "arch-boundary",
          convention: "file I/O belongs in adapters only",
          rationale: "the core package must stay pure",
          severity: "high",
          antiPattern: "importing node:fs from core",
        },
      ]);
      // …and the file's own envelope survives the write (it was not authored here).
      expect(written.catalogue?.source).toBe("the team handbook");
    } finally {
      cleanup();
    }
  });

  it("writes into a project with no .rennet directory yet, and clearing every rule reads empty", () => {
    const { root, cleanup } = tempProject();
    try {
      expect(
        saveConventionCatalogue(root, [{ convention: "keep main releasable", severity: "high" }])
          .catalogue?.rules,
      ).toHaveLength(1);
      const cleared = saveConventionCatalogue(root, []);
      expect(cleared.catalogue).toBeUndefined();
      expect(cleared.reason).toBe("empty");
    } finally {
      cleanup();
    }
  });
});
