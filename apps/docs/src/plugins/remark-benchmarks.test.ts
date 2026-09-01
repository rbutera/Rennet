import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import remarkBenchmarks, {
  benchmarkData,
  invalidateBenchmarkRenders,
  readBenchmarkData,
  renderBenchmarkHtml,
  verifyRenderedBenchmarks,
} from "./remark-benchmarks.mjs";

// The build-time control for #731 9.8/9.9. The docs benchmarks page renders committed
// measurement data and MUST NOT be able to render blanks: a page showing "—" where a
// number belongs is indistinguishable from a very fast pipeline. So corrupting the data
// has to stop the build, and the assertions below drive the real plugin — including the
// one that proves it is actually registered in the astro build pipeline, because
// "registered" is a control-flow claim and control-flow claims get executed.

const VALID = {
  version: 1,
  provenance: {
    exportedAt: "2026-09-01T10:00:00.000Z",
    machine: "darwin arm64, 12 cores",
    revision: "abc1234",
  },
  stages: [
    {
      kind: "repo-map",
      mode: "unattributed",
      outcome: "complete",
      stage: "tree",
      samples: 2,
      medianMs: 40,
      slowestMs: 60,
    },
    {
      kind: "generation",
      mode: "dual-model",
      outcome: "complete",
      stage: "lens-draft",
      lens: "flagged",
      samples: 2,
      medianMs: 30_000,
      slowestMs: 41_000,
    },
  ],
  runs: [
    {
      kind: "repo-map",
      mode: "unattributed",
      count: 2,
      complete: 2,
      failed: 0,
      aborted: 0,
      medianMs: 90,
      producers: ["cli-map"],
    },
  ],
};

function write(data: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "rennet-docs-bench-")), "benchmarks.json");
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data), "utf8");
  return path;
}

describe("the committed benchmark data", () => {
  it("renders stage tables split by run kind and derived mode", () => {
    const html = renderBenchmarkHtml(readBenchmarkData(write(VALID)));
    expect(html).toContain("darwin arm64, 12 cores");
    expect(html).toContain("abc1234");
    expect(html).toContain("Repo Map build");
    expect(html).toContain("Dual model (council)");
    expect(html).toContain("<code>lens-draft</code>");
    // A mode with no rows gets no section — its absence is the honest statement.
    expect(html).not.toContain("Codex only");
  });

  it("FAILS when the data is missing", () => {
    expect(() => readBenchmarkData(join(tmpdir(), "definitely-not-here-731.json"))).toThrow(
      /missing/,
    );
  });

  it("FAILS when the data is not JSON", () => {
    expect(() => readBenchmarkData(write("{ truncated"))).toThrow(/not valid JSON/);
  });

  it("FAILS on a wrong version, a stripped provenance, or a row with no measurement", () => {
    expect(() => readBenchmarkData(write({ ...VALID, version: 2 }))).toThrow(/version/);
    expect(() =>
      readBenchmarkData(write({ ...VALID, provenance: { machine: "x", revision: "y" } })),
    ).toThrow(/exportedAt/);
    expect(() =>
      readBenchmarkData(
        write({
          ...VALID,
          stages: [
            {
              kind: "repo-map",
              mode: "unattributed",
              outcome: "complete",
              stage: "tree",
              samples: 1,
            },
          ],
        }),
      ),
    ).toThrow(/medianMs/);
    // An empty table would render a heading over nothing, which reads as "nothing to see"
    // rather than "the export lost its rows".
    expect(() => readBenchmarkData(write({ ...VALID, stages: [] }))).toThrow(/no stage rows/);
  });
});

describe("the plugin is what the docs build runs", () => {
  it("is registered in astro.config's remark pipeline", async () => {
    // Not a claim in a comment: the config is imported and the registration inspected.
    const config = (await import("../../astro.config.mjs")).default as {
      markdown: { remarkPlugins: unknown[] };
    };
    expect(config.markdown.remarkPlugins).toContain(remarkBenchmarks);
  });

  it("verifies the data on every build through an integration, not only the transform", async () => {
    // The remark plugin alone did NOT stop the build, and this is the assertion that
    // records why: Astro caches rendered Markdown, so an unchanged page never re-runs the
    // transform — a corrupted data file completed a full `astro build` with exit code 0.
    // `astro:config:setup` runs regardless of that cache.
    const config = (await import("../../astro.config.mjs")).default as {
      integrations: { name: string; hooks: Record<string, () => void> }[];
    };
    const integration = config.integrations.find(
      (entry) => entry?.name === "rennet-benchmark-data",
    );
    expect(integration).toBeDefined();
    expect(typeof integration?.hooks["astro:config:setup"]).toBe("function");
    // The hook is the verification: it reads the repo's own committed data and throws
    // when it cannot.
    expect(() => integration?.hooks["astro:config:setup"]?.()).not.toThrow();
    expect(benchmarkData().name).toBe("rennet-benchmark-data");
  });

  function fenceTree() {
    return {
      type: "root",
      children: [{ type: "code", lang: "rennet-benchmarks", value: "" }],
    } as { type: string; children: { type: string; lang?: string; value: string }[] };
  }

  it("replaces the fence with tables built from the REPO'S OWN committed data", () => {
    // Not a fixture: this reads `docs/data/benchmarks.json` as it stands in the commit, so
    // the test also fails if what we committed is unusable.
    const tree = fenceTree();
    remarkBenchmarks()(tree);
    const node = tree.children[0];
    expect(node?.type).toBe("html");
    expect(node?.value).toContain("Measured on");
    expect(node?.value).toContain("Repo Map build");
    expect(node?.lang).toBeUndefined();
  });

  it("STOPS the build when the data is corrupt — the throw escapes the transform", () => {
    // The 9.9 control, executed rather than reasoned about: the same transformer, the same
    // page, one corrupted file. If the plugin swallowed the read failure the fence would
    // survive as a code node and the build would ship an empty benchmarks page.
    const corrupt = write({ ...VALID, stages: [] });
    const tree = fenceTree();
    expect(() => remarkBenchmarks({ dataPath: corrupt })(tree)).toThrow(/no stage rows/);
    expect(tree.children[0]?.type).toBe("code");
    expect(() =>
      remarkBenchmarks({ dataPath: join(tmpdir(), "gone-731.json") })(fenceTree()),
    ).toThrow(/missing/);
  });
});

describe("the BUILT page must state the committed data (#731 N2)", () => {
  /** A dist tree holding one rendered benchmarks page and one unrelated page. */
  function dist(machine: string): string {
    const root = mkdtempSync(join(tmpdir(), "rennet-docs-dist-"));
    mkdirSync(join(root, "developing", "reference"), { recursive: true });
    writeFileSync(
      join(root, "developing", "reference", "index.html"),
      `<html><body><p class="benchmark-provenance">Measured on <strong>${machine}</strong>.</p></body></html>`,
      "utf8",
    );
    writeFileSync(join(root, "index.html"), "<html><body>Home</body></html>", "utf8");
    return root;
  }

  it("passes when the build states the committed provenance", () => {
    const paths = verifyRenderedBenchmarks({
      dir: dist(VALID.provenance.machine),
      data: VALID,
    });
    // Only the page that rendered the data is checked; the marker is what finds it.
    expect(paths).toHaveLength(1);
  });

  it("FAILS when the built page carries a previous export's provenance", () => {
    // The failure validation could never catch: nothing is wrong with the data, the page
    // simply was not re-rendered from it. Reported twice in review; see the plugin's own
    // note for what a real build was observed to do on this checkout.
    expect(() =>
      verifyRenderedBenchmarks({ dir: dist("a machine from a previous export"), data: VALID }),
    ).toThrow(/serving stale numbers/);
  });

  it("FAILS when NO built page rendered the data at all", () => {
    // Otherwise this check quietly stops meaning anything the moment the page moves or the
    // fence is renamed — a green build asserting nothing.
    const empty = mkdtempSync(join(tmpdir(), "rennet-docs-dist-empty-"));
    writeFileSync(join(empty, "index.html"), "<html><body>Home</body></html>", "utf8");
    expect(() => verifyRenderedBenchmarks({ dir: empty, data: VALID })).toThrow(
      /no built page rendered/,
    );
  });

  it("is wired into the build as `astro:build:done`, not only as validation", () => {
    // A control-flow claim, executed: the hook exists and it is the one that runs after
    // the pages are emitted.
    const integration = benchmarkData();
    expect(typeof integration.hooks["astro:config:setup"]).toBe("function");
    expect(typeof integration.hooks["astro:build:done"]).toBe("function");
  });
});

describe("changed measurements drop Astro's stored renders (#731 N2)", () => {
  // The invalidation and the verification are a pair, and each covers what the other
  // cannot. This is the invalidation, unit-tested; the pair was also proven on a REAL
  // `astro build`: with a valid edit to the data, removing this call made the build fail
  // with the verification's own message and the previous export's provenance still in
  // `dist`, and restoring it produced the new numbers with exit 0.
  function cacheDir(): string {
    const root = mkdtempSync(join(tmpdir(), "rennet-docs-cache-"));
    writeFileSync(join(root, "data-store.json"), '{"rendered":"old"}', "utf8");
    return root;
  }

  it("drops the store the first time it sees a digest, and not again", () => {
    const dir = cacheDir();
    const first = invalidateBenchmarkRenders({ cacheDir: dir, data: VALID });
    expect(first.invalidated).toBe(true);
    expect(existsSync(join(dir, "data-store.json"))).toBe(false);

    // An ordinary docs build must keep its cache — an invalidation that fired every time
    // would be a full re-render on every build wearing the name of a correctness fix.
    writeFileSync(join(dir, "data-store.json"), '{"rendered":"fresh"}', "utf8");
    expect(invalidateBenchmarkRenders({ cacheDir: dir, data: VALID }).invalidated).toBe(false);
    expect(readFileSync(join(dir, "data-store.json"), "utf8")).toBe('{"rendered":"fresh"}');
  });

  it("drops it again as soon as a measurement changes", () => {
    const dir = cacheDir();
    invalidateBenchmarkRenders({ cacheDir: dir, data: VALID });
    writeFileSync(join(dir, "data-store.json"), '{"rendered":"fresh"}', "utf8");
    const changed = {
      ...VALID,
      stages: [{ ...VALID.stages[0], medianMs: VALID.stages[0].medianMs + 1 }, VALID.stages[1]],
    };
    expect(invalidateBenchmarkRenders({ cacheDir: dir, data: changed }).invalidated).toBe(true);
    expect(existsSync(join(dir, "data-store.json"))).toBe(false);
  });
});

describe("the docs validator pins the same vocabulary the protocol does (#731 N5)", () => {
  it("refuses a stage row filed under the wrong kind", () => {
    // `lens-draft` under `repo-map` is a model-backed stage attributed to the deterministic
    // pipeline. The validator used to accept any string here and render it.
    expect(() =>
      readBenchmarkData(
        write({
          ...VALID,
          stages: [{ ...VALID.stages[1], kind: "repo-map" }],
        }),
      ),
    ).toThrow(/does not belong to a repo-map run/);
    // The control: the SAME row under its own kind is accepted.
    expect(() => readBenchmarkData(write(VALID))).not.toThrow();
  });

  it("refuses an unknown stage, a lane-scoped row with no lens, and a run-wide row with one", () => {
    expect(() =>
      readBenchmarkData(write({ ...VALID, stages: [{ ...VALID.stages[0], stage: "invented" }] })),
    ).toThrow(/does not belong to a repo-map run/);
    expect(() =>
      readBenchmarkData(write({ ...VALID, stages: [{ ...VALID.stages[1], lens: undefined }] })),
    ).toThrow(/must name its lens/);
    expect(() =>
      readBenchmarkData(write({ ...VALID, stages: [{ ...VALID.stages[0], lens: "flagged" }] })),
    ).toThrow(/must not name a lens/);
  });

  it("refuses a stage row with no outcome and a run group with no producer", () => {
    expect(() =>
      readBenchmarkData(write({ ...VALID, stages: [{ ...VALID.stages[0], outcome: undefined }] })),
    ).toThrow(/outcome is not a run outcome/);
    expect(() =>
      readBenchmarkData(write({ ...VALID, runs: [{ ...VALID.runs[0], producers: [] }] })),
    ).toThrow(/must name at least one producer/);
  });

  it("allows an absent median only when NOTHING in the group completed", () => {
    // Absence is the honest statement for a group of failures. Absence beside completed
    // runs is a lost number, and the two must not look alike.
    expect(() =>
      readBenchmarkData(
        write({
          ...VALID,
          runs: [{ ...VALID.runs[0], medianMs: undefined }],
        }),
      ),
    ).toThrow(/states no median/);
    expect(() =>
      readBenchmarkData(
        write({
          ...VALID,
          runs: [{ ...VALID.runs[0], count: 2, complete: 0, failed: 2, medianMs: undefined }],
        }),
      ),
    ).not.toThrow();
  });
});

describe("the rendered tables state what they are not merging (#731 N8)", () => {
  it("carries an outcome column and says the median is over complete runs", () => {
    const html = renderBenchmarkHtml(readBenchmarkData(write(VALID)));
    expect(html).toContain("<th>Outcome</th>");
    expect(html).toContain("Median complete run:");
    expect(html).toContain("Recorded by cli-map");
  });

  it("says so plainly when a group has no complete run to time", () => {
    const html = renderBenchmarkHtml(
      readBenchmarkData(
        write({
          ...VALID,
          runs: [{ ...VALID.runs[0], count: 2, complete: 0, failed: 2, medianMs: undefined }],
        }),
      ),
    );
    expect(html).toContain("No run in this group completed");
    expect(html).not.toContain("Median complete run:");
  });
});
