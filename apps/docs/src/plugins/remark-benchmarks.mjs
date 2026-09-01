import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
/** Astro's build output, checked after the fact — see {@link verifyRenderedBenchmarks}. */
const DIST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist");

/** The marker `renderBenchmarkHtml` puts on every rendered provenance line. It is how the
 *  post-build check finds the pages that rendered the data without anyone maintaining a
 *  path list, and it is why that class name must not change without changing this. */
const PROVENANCE_MARKER = 'class="benchmark-provenance"';

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
const OUTCOMES = ["complete", "failed", "aborted"];

/**
 * The stage vocabulary PER KIND, mirroring `benchmarkRunSchema`'s own per-kind check in
 * `@rennet/protocol`. It is duplicated rather than imported on purpose (apps/docs depends
 * on no Rennet package but the theme, and a `.mjs` remark plugin runs before any TypeScript
 * build), so the lists are kept honest by `remark-benchmarks.test.ts`, which asserts a
 * cross-kind row is refused. Accepting an arbitrary string here meant a `lens-draft` row
 * filed under `repo-map` — a model-backed stage attributed to the deterministic pipeline —
 * rendered without complaint.
 *
 * The record-level rules the protocol also enforces (a stage names its harness AND its
 * model or neither; a repo-map stage names no provider at all) have NO counterpart here:
 * the committed artifact is an AGGREGATE and carries no harness, model or subject. What is
 * mirrorable is the vocabulary, the lens scoping and the closed enums, and that is what
 * this validator checks.
 */
const STAGES_FOR_KIND = {
  "repo-map": [
    "scout",
    "resolve",
    "tree",
    "workspace",
    "conventions",
    "symbols",
    "build",
    "verify",
    "store",
    "total",
  ],
  generation: [
    "report",
    "report-classification",
    "lens-draft",
    "lens-repair",
    "lens-post-process",
    "coverage",
    "reveal",
    "first-core-board",
  ],
};

/** The lane-scoped stages, which must name a lens; every other stage must not. */
const LENS_SCOPED_STAGES = ["lens-draft", "lens-repair", "lens-post-process", "first-core-board"];
const LENSES = ["design", "sequence", "decisions", "flagged", "noise"];

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
    if (!OUTCOMES.includes(row.outcome)) bad(`stages[${index}].outcome is not a run outcome`);
    requireString(row.stage, `stages[${index}].stage`, path);
    // Pinned per kind, not merely "a string": a `lens-draft` row filed under `repo-map`
    // attributes a model-backed stage to the deterministic pipeline, and the page renders
    // it beside the map's own stages as though the map had run a provider.
    if (!STAGES_FOR_KIND[row.kind].includes(row.stage)) {
      bad(`stages[${index}].stage '${row.stage}' does not belong to a ${row.kind} run`);
    }
    // Mirrors the protocol refine: no repo-map stage may claim a provider, so the only
    // derivable mode for the deterministic pipeline is "unattributed". A hand-edited
    // "dual-model" map row would render a council label onto a build that ran no model.
    if (row.kind === "repo-map" && row.mode !== "unattributed") {
      bad(`stages[${index}] is a repo-map row and its mode can only be 'unattributed'`);
    }
    const laneScoped = LENS_SCOPED_STAGES.includes(row.stage);
    if (row.lens !== undefined && !LENSES.includes(row.lens)) {
      bad(`stages[${index}].lens is not a lens`);
    }
    if (laneScoped && row.lens === undefined) {
      bad(`stages[${index}] measures one lane and must name its lens`);
    }
    if (!laneScoped && row.lens !== undefined) {
      bad(`stages[${index}] is run-wide and must not name a lens`);
    }
    requireCount(row.samples, `stages[${index}].samples`, path);
    requireCount(row.medianMs, `stages[${index}].medianMs`, path);
    requireCount(row.slowestMs, `stages[${index}].slowestMs`, path);
  }
  for (const [index, row] of data.runs.entries()) {
    if (row === null || typeof row !== "object") bad(`runs[${index}] must be an object`);
    if (!KINDS.includes(row.kind)) bad(`runs[${index}].kind is not a known run kind`);
    if (!MODES.includes(row.mode)) bad(`runs[${index}].mode is not a derived mode`);
    if (row.kind === "repo-map" && row.mode !== "unattributed") {
      bad(`runs[${index}] is a repo-map row and its mode can only be 'unattributed'`);
    }
    requireCount(row.count, `runs[${index}].count`, path);
    requireCount(row.complete, `runs[${index}].complete`, path);
    requireCount(row.failed, `runs[${index}].failed`, path);
    requireCount(row.aborted, `runs[${index}].aborted`, path);
    // ABSENT is legal and means "nothing in this group completed"; present must be a
    // number. A group of three failures has no latency, and a `0` there would read as an
    // instantaneous pipeline rather than as one that never finished.
    if (row.medianMs !== undefined) requireCount(row.medianMs, `runs[${index}].medianMs`, path);
    if (row.medianMs === undefined && row.complete > 0) {
      bad(`runs[${index}] completed ${row.complete} runs but states no median`);
    }
    if (!Array.isArray(row.producers) || row.producers.length === 0) {
      bad(`runs[${index}].producers must name at least one producer`);
    }
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
        // The median is over the COMPLETE runs only, and says so. Mixing a run that
        // finished with one that fell over halfway reports a number describing neither.
        parts.push(
          `<p>${summary.count} ${summary.count === 1 ? "run" : "runs"} — ${
            summary.complete ?? 0
          } complete, ${summary.failed ?? 0} failed, ${summary.aborted ?? 0} aborted. ${
            summary.medianMs === undefined
              ? "No run in this group completed, so it states no median."
              : `Median complete run: ${formatMs(summary.medianMs)}.`
          } Recorded by ${escapeHtml((summary.producers ?? []).join(", "))}.</p>`,
        );
      }
      parts.push(
        "<table><thead><tr><th>Stage</th><th>Lens</th><th>Outcome</th><th>Samples</th><th>Median</th><th>Slowest</th></tr></thead><tbody>",
      );
      for (const row of rows) {
        parts.push(
          `<tr><td><code>${escapeHtml(row.stage)}</code></td><td>${
            row.lens ? escapeHtml(row.lens) : "—"
          }</td><td>${escapeHtml(row.outcome)}</td><td>${row.samples}</td><td>${formatMs(
            row.medianMs,
          )}</td><td>${formatMs(row.slowestMs)}</td></tr>`,
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

/** Every built HTML page that rendered the benchmark data, found by the provenance marker
 *  rather than by a path list that could drift away from the docs. */
function renderedBenchmarkPages(dir) {
  const pages = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
    const path = join(entry.parentPath ?? entry.path ?? dir, entry.name);
    const html = readFileSync(path, "utf8");
    if (html.includes(PROVENANCE_MARKER)) pages.push({ path, html });
  }
  return pages;
}

/**
 * Assert that what was BUILT states the data that is committed.
 *
 * This is a check on the output rather than a guess about the cache, and the difference is
 * the whole point. Validating the data file catches a CORRUPT file; it cannot catch a
 * VALID edit that never reached the HTML, because there is nothing wrong to throw about.
 * Astro's content layer digests a page's raw bytes to decide whether to reuse its rendered
 * HTML, and `docs/data/benchmarks.json` is not one of those bytes — the fence carries no
 * number and the transform reads the file at render time — so a page whose Markdown had
 * not changed could in principle be served with numbers that are no longer true.
 *
 * What was observed: the stale render is REAL and was reproduced on a real build during
 * review — a valid edit to `docs/data/benchmarks.json`, `astro build` exited 0, and the
 * emitted page still carried the previous export's provenance, served from Astro's
 * persisted content store (see `invalidateBenchmarkRenders` below, which repairs it).
 * This check is the proof that the repair keeps working: it makes the property the docs
 * page CLAIMS — "no number on it was typed by hand", provenance included — something the
 * build verifies on every run rather than assumes.
 *
 * Two failures, both loud, because both are the same lie in different clothes: a page that
 * renders the wrong provenance, and NO page rendering the data at all — the second being
 * how this check would quietly stop meaning anything if the page were moved or the fence
 * renamed.
 *
 * @param {{ dir?: string, data?: any }} [options]
 */
export function verifyRenderedBenchmarks({ dir = DIST_ROOT, data } = {}) {
  let pages;
  try {
    pages = renderedBenchmarkPages(dir);
  } catch (error) {
    fail(`the built docs could not be read — ${error?.message ?? error}`, dir);
  }
  if (pages.length === 0) {
    fail("no built page rendered the benchmark data; the page or the fence has moved", dir);
  }
  for (const { path, html } of pages) {
    if (html.includes(escapeHtml(data.provenance.machine))) continue;
    fail(
      `${path} was built without the committed provenance (${data.provenance.machine}); it is serving stale numbers`,
      dir,
    );
  }
  return pages.map(({ path }) => path);
}

/**
 * Drop Astro's persisted content store when the measurements change, so the pages that
 * render them are rebuilt.
 *
 * THIS IS THE HALF THAT WAS MISSING, and it is not theoretical — it was caught by the
 * verification below, on a real build: with a valid edit to `docs/data/benchmarks.json`,
 * `astro build` completed and the emitted page still carried the PREVIOUS export's
 * provenance. Astro's content layer keeps rendered pages in `node_modules/.astro/
 * data-store.json`, keyed on a digest of each page's own bytes. The benchmarks page has no
 * number in it — the fence is empty and the transform reads the file at render time — so
 * its digest does not move when the data does, and the stored render is reused.
 *
 * Keying the page on the data by writing into it was not available: `src/content/docs/` is
 * a byte copy of the canonical `docs/` tree and `scripts/check-docs.mjs` enforces exactly
 * that. So the store is dropped instead, and only when the data's hash actually changes —
 * an ordinary docs build keeps its cache. `cacheDir` comes from Astro's own resolved
 * config rather than a guessed path.
 *
 * @param {{ cacheDir: string, data?: unknown }} options
 */
export function invalidateBenchmarkRenders({ cacheDir, data }) {
  const digest = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  const marker = join(cacheDir, "rennet-benchmarks.digest");
  let previous;
  try {
    previous = readFileSync(marker, "utf8").trim();
  } catch {
    // No marker yet: a first build, or a cleaned cache. Either way the store is dropped
    // once and the marker written, so the next build is a normal cached one.
  }
  if (previous === digest) return { digest, invalidated: false };
  mkdirSync(cacheDir, { recursive: true });
  const store = join(cacheDir, "data-store.json");
  if (existsSync(store)) rmSync(store);
  writeFileSync(marker, `${digest}\n`, "utf8");
  return { digest, invalidated: true };
}

/**
 * The committed data's build-time contract, as an INTEGRATION rather than a remark side
 * effect. Three jobs, because the failures are different:
 *
 * 1. VALIDATE the data on every build, regardless of what any cache holds, so a corrupt or
 *    missing file stops the build even when no page re-renders.
 * 2. INVALIDATE the stored renders when the data changed (see
 *    {@link invalidateBenchmarkRenders}), so a VALID change actually reaches the HTML.
 *    Validation can never do this: there is nothing wrong to throw about.
 * 3. VERIFY THE OUTPUT afterwards (see {@link verifyRenderedBenchmarks}), so if the
 *    invalidation ever stops working the build FAILS instead of shipping stale numbers.
 *
 * Three is what makes two trustworthy. The invalidation reasons about a cache this file
 * does not own; the verification reads what was actually written, and holds whatever the
 * cause.
 *
 * @param {{ dir?: string, cacheDir?: string }} [options]
 */
export function benchmarkData({ dir = DIST_ROOT, cacheDir } = {}) {
  return {
    name: "rennet-benchmark-data",
    hooks: {
      "astro:config:setup": ({ config } = {}) => {
        const data = readBenchmarkData();
        const resolved =
          cacheDir ?? (config?.cacheDir ? fileURLToPath(config.cacheDir) : undefined);
        if (resolved !== undefined) invalidateBenchmarkRenders({ cacheDir: resolved, data });
      },
      "astro:build:done": () => {
        verifyRenderedBenchmarks({ dir, data: readBenchmarkData() });
      },
    },
  };
}
