import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build-time benchmark rendering (#731 9.8, design D8 consumer 3).
 *
 * The benchmarks page carries a ```rennet-benchmarks fence and nothing else; this plugin
 * replaces it with tables built from `docs/data/benchmarks.json` — the artifact
 * `rennet benchmarks export` writes from real recorded runs. The page therefore cannot
 * carry a hand-written number: there is no number in the Markdown to hand-write.
 *
 * MISSING OR CORRUPT DATA FAILS THE BUILD. That is the point of doing this at build time
 * rather than shipping a client fetch: a docs site that renders "—" where a measurement
 * should be is a site that quietly lost its provenance, and the reader cannot tell that
 * from a genuinely fast pipeline. Validation is deliberately hand-rolled rather than
 * importing the protocol schema — apps/docs depends on no Rennet package but the theme,
 * and a `.mjs` remark plugin runs before any TypeScript build.
 */

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DATA_PATH = resolve(WORKSPACE_ROOT, "docs/data/benchmarks.json");

const MODE_LABEL = {
  "dual-model": "Dual model (council)",
  "claude-only": "Claude only",
  "codex-only": "Codex only",
  unattributed: "No provider stage",
};

const KIND_LABEL = {
  "repo-map": "Repo Map build",
  generation: "Lens generation and round report",
};

const MODES = Object.keys(MODE_LABEL);
const KINDS = Object.keys(KIND_LABEL);

function fail(message, path) {
  throw new Error(`remark-benchmarks: ${message} (${path})`);
}

function requireString(value, where, path) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${where} must be a non-empty string`, path);
  }
  return value;
}

function requireCount(value, where, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${where} must be a non-negative number`, path);
  }
  return value;
}

/** Read and validate the committed data. Every failure mode a corrupt file can take —
 *  absent, unparseable, wrong version, missing provenance, a row with no measurement —
 *  throws here, which is what makes the control in `remark-benchmarks.test.ts` real. */
export function readBenchmarkData(path = DATA_PATH) {
  const bad = (message) => fail(message, path);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    bad("the committed benchmark data is missing; run `rennet benchmarks export`");
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    bad(`the committed benchmark data is not valid JSON — ${error?.message ?? error}`);
  }
  if (data === null || typeof data !== "object") bad("the benchmark data must be an object");
  if (data.version !== 1) bad(`unsupported benchmark data version ${String(data.version)}`);
  const provenance = data.provenance;
  if (provenance === null || typeof provenance !== "object") bad("provenance is missing");
  requireString(provenance.exportedAt, "provenance.exportedAt", path);
  requireString(provenance.machine, "provenance.machine", path);
  requireString(provenance.revision, "provenance.revision", path);
  if (!Array.isArray(data.stages)) bad("stages must be an array");
  if (!Array.isArray(data.runs)) bad("runs must be an array");
  if (data.stages.length === 0) bad("the benchmark data carries no stage rows");
  for (const [index, row] of data.stages.entries()) {
    if (row === null || typeof row !== "object") bad(`stages[${index}] must be an object`);
    if (!KINDS.includes(row.kind)) bad(`stages[${index}].kind is not a known run kind`);
    if (!MODES.includes(row.mode)) bad(`stages[${index}].mode is not a derived mode`);
    requireString(row.stage, `stages[${index}].stage`, path);
    requireCount(row.samples, `stages[${index}].samples`, path);
    requireCount(row.medianMs, `stages[${index}].medianMs`, path);
    requireCount(row.slowestMs, `stages[${index}].slowestMs`, path);
  }
  for (const [index, row] of data.runs.entries()) {
    if (row === null || typeof row !== "object") bad(`runs[${index}] must be an object`);
    if (!KINDS.includes(row.kind)) bad(`runs[${index}].kind is not a known run kind`);
    if (!MODES.includes(row.mode)) bad(`runs[${index}].mode is not a derived mode`);
    requireCount(row.count, `runs[${index}].count`, path);
    requireCount(row.medianMs, `runs[${index}].medianMs`, path);
  }
  return data;
}

function formatMs(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Render the tables. Split by run kind and then by DERIVED mode, never merged: a Repo Map
 *  stage and a lens stage measure different pipelines, and a Claude-only run and a council
 *  run are different configurations. A mode with no recorded run simply has no section —
 *  its absence is the honest statement that nothing was measured under it. */
export function renderBenchmarkHtml(data) {
  const parts = [];
  parts.push(
    `<p class="benchmark-provenance">Measured on <strong>${escapeHtml(
      data.provenance.machine,
    )}</strong> at revision <code>${escapeHtml(
      data.provenance.revision,
    )}</code>, exported ${escapeHtml(data.provenance.exportedAt.slice(0, 10))}.</p>`,
  );
  for (const kind of KINDS) {
    const kindStages = data.stages.filter((row) => row.kind === kind);
    if (kindStages.length === 0) {
      parts.push(
        `<h2>${escapeHtml(KIND_LABEL[kind])}</h2><p>No run of this kind has been exported yet, so this page states nothing about it.</p>`,
      );
      continue;
    }
    parts.push(`<h2>${escapeHtml(KIND_LABEL[kind])}</h2>`);
    for (const mode of MODES) {
      const rows = kindStages.filter((row) => row.mode === mode);
      if (rows.length === 0) continue;
      const summary = data.runs.find((row) => row.kind === kind && row.mode === mode);
      parts.push(`<h3>${escapeHtml(MODE_LABEL[mode])}</h3>`);
      if (summary) {
        parts.push(
          `<p>${summary.count} ${summary.count === 1 ? "run" : "runs"} — ${
            summary.complete ?? 0
          } complete, ${summary.failed ?? 0} failed, ${
            summary.aborted ?? 0
          } aborted. Median run: ${formatMs(summary.medianMs)}.</p>`,
        );
      }
      parts.push(
        "<table><thead><tr><th>Stage</th><th>Lens</th><th>Samples</th><th>Median</th><th>Slowest</th></tr></thead><tbody>",
      );
      for (const row of rows) {
        parts.push(
          `<tr><td><code>${escapeHtml(row.stage)}</code></td><td>${
            row.lens ? escapeHtml(row.lens) : "—"
          }</td><td>${row.samples}</td><td>${formatMs(row.medianMs)}</td><td>${formatMs(
            row.slowestMs,
          )}</td></tr>`,
        );
      }
      parts.push("</tbody></table>");
    }
  }
  return parts.join("\n");
}

/**
 * `dataPath` exists so the corrupt-data control can drive THIS transformer over a broken
 * file and watch the build-stopping throw actually escape — a claim about control flow
 * gets executed, not reasoned. The docs build passes no options and reads the committed
 * path.
 */
export default function remarkBenchmarks({ dataPath = DATA_PATH } = {}) {
  return function transformer(tree) {
    const targets = [];
    const walk = (node) => {
      if (!node || typeof node !== "object" || !Array.isArray(node.children)) return;
      for (const child of node.children) {
        if (child.type === "code" && child.lang === "rennet-benchmarks") targets.push(child);
        else walk(child);
      }
    };
    walk(tree);
    if (targets.length === 0) return;
    // Read once per page, and let the throw escape: a page that asked for the data and
    // could not have it must stop the build, not render an empty table.
    const html = renderBenchmarkHtml(readBenchmarkData(dataPath));
    for (const node of targets) {
      node.type = "html";
      node.value = html;
      delete node.lang;
      delete node.meta;
    }
  };
}

/**
 * The build-time verification, as an INTEGRATION rather than a remark side effect.
 *
 * The remark plugin alone was not enough and the difference is not theoretical: Astro
 * caches rendered Markdown, so a build whose `.md` bytes are unchanged never re-runs the
 * transform — a corrupted `benchmarks.json` sailed through a full `astro build` with exit
 * code 0 while the page served the previously rendered numbers. That is precisely the
 * "stale or invented numbers" failure the verification exists to prevent, and it was found
 * by running the build, not by reading it.
 *
 * `astro:build:start` runs on every build regardless of any cache, so the data is read and
 * validated there, through the same reader the renderer uses.
 */
export function benchmarkData() {
  return {
    name: "rennet-benchmark-data",
    hooks: {
      "astro:build:start": () => {
        readBenchmarkData();
      },
    },
  };
}
