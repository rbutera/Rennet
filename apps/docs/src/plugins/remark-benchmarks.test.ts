import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import remarkBenchmarks, {
  benchmarkData,
  readBenchmarkData,
  renderBenchmarkHtml,
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
      stage: "tree",
      samples: 2,
      medianMs: 40,
      slowestMs: 60,
    },
    {
      kind: "generation",
      mode: "dual-model",
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
          stages: [{ kind: "repo-map", mode: "unattributed", stage: "tree", samples: 1 }],
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
    // `astro:build:start` runs regardless of that cache.
    const config = (await import("../../astro.config.mjs")).default as {
      integrations: { name: string; hooks: Record<string, () => void> }[];
    };
    const integration = config.integrations.find(
      (entry) => entry?.name === "rennet-benchmark-data",
    );
    expect(integration).toBeDefined();
    expect(typeof integration?.hooks["astro:build:start"]).toBe("function");
    // The hook is the verification: it reads the repo's own committed data and throws
    // when it cannot.
    expect(() => integration?.hooks["astro:build:start"]?.()).not.toThrow();
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
