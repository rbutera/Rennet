import type { Patchset } from "@rennet/types";
import { useEffect, useMemo, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// GenerationNarration (issue #71) — watch the AI work, live, instead of a spinner.
//
// The AI-default wire (#132) made the real review the default and gave the load a
// "running" state; today that state is a static line ("Running your AI review…").
// The Design Doctrine is absolute (interaction law 3, R26): a spinner over an
// empty screen is a violation from the FIRST screen. This turns that running
// state into a live narrative feed — the reviewer SEES their machine working.
//
// HONESTY (issue #71, "honest about what the LLM did"; the doctrine's whole point):
// the feed shows only REAL signal. Two kinds of line:
//   • FACTS  — the real changeset shape, read straight off the captured patchset
//     that is already in the renderer (file count, hunk count, +adds/−dels, the
//     largest files by name). This is exactly what the pipeline reads first, so
//     it is a true account of the review's input, known synchronously.
//   • STAGES — the real, deterministic pipeline sequence `buildReviewCanvases`
//     runs (decompose → budget gate → angles → ordering → narration). These are
//     DESCRIPTIONS of the work, never claimed complete: no checkmarks, no percent,
//     no fabricated counts. The frontier line pulses to say "still working".
//
// What is NOT here (and why): the desktop bridge is single-shot request/response
// (`review.canvases` resolves once with the whole set), so there is no per-stage
// completion event to render. True event-driven progress — each stage ticking off
// as the engine finishes it, canvases arriving incrementally — needs the engine to
// EMIT progress (the R35 post-commit change feed / context-update stream already
// exist in @rennet/core) AND a streaming transport on the bridge. That is a
// follow-up; this feed is the honest, feasible version that never fakes motion.
// ─────────────────────────────────────────────────────────────────────────────

/** The real shape of the captured changeset, read off the patchset in the renderer. */
export interface ChangesetShape {
  fileCount: number;
  hunkCount: number;
  additions: number;
  deletions: number;
  /** Per-file hunk counts, in patchset order. */
  files: { path: string; hunks: number }[];
}

/**
 * Read the real changeset shape off a captured patchset. Pure and synchronous —
 * this is the true input the pipeline decomposes, so narrating it is honest signal,
 * not a fabricated progress bar. Binary files contribute no hunks; a null add/del
 * count (a lossy/degraded capture) counts as zero rather than crashing.
 */
export function changesetShape(patchset: Patchset | undefined): ChangesetShape {
  const files = patchset?.files ?? [];
  let hunkCount = 0;
  let additions = 0;
  let deletions = 0;
  const perFile: { path: string; hunks: number }[] = [];
  for (const file of files) {
    // A hunk header is a line beginning `@@ ` in unified-diff text; binary files
    // carry no hunks. Count the real markers rather than estimating.
    const hunks = file.binary ? 0 : (file.patch.match(/^@@ /gm)?.length ?? 0);
    hunkCount += hunks;
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
    perFile.push({ path: file.path, hunks });
  }
  return { fileCount: files.length, hunkCount, additions, deletions, files: perFile };
}

/** One line in the live feed. `summary`/`file` are resolved FACTS; `stage` is the work ahead. */
export interface FeedLine {
  id: string;
  kind: "summary" | "file" | "stage";
  label: string;
  detail?: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Build the ordered feed from a real changeset shape. Facts first (they are known
 * synchronously and true), then the deterministic pipeline stages the engine runs.
 * Pure, so it is the unit under test — no timers, no DOM.
 */
export function narrationFeedLines(shape: ChangesetShape): FeedLine[] {
  const lines: FeedLine[] = [];

  lines.push({
    id: "changeset",
    kind: "summary",
    label: "Reading the changeset",
    detail:
      shape.fileCount === 0
        ? "an empty changeset"
        : `${plural(shape.fileCount, "file")}, ${plural(shape.hunkCount, "hunk")}, +${shape.additions} −${shape.deletions}`,
  });

  // Name the largest files by real hunk count — the ones the reviewer most wants
  // to see the machine chewing on. A stable secondary sort on path keeps the order
  // deterministic when hunk counts tie (so the test and the screenshot agree).
  const named = [...shape.files]
    .filter((file) => file.hunks > 0)
    .sort((left, right) => right.hunks - left.hunks || left.path.localeCompare(right.path))
    .slice(0, 3);
  for (const file of named) {
    lines.push({
      id: `file:${file.path}`,
      kind: "file",
      label: file.path,
      detail: plural(file.hunks, "hunk"),
    });
  }

  // The real, deterministic pipeline sequence (`buildReviewCanvases`, @rennet/core):
  // decompose → route-plan budget gate → decomposition angle → ordering → rollup
  // narration. Descriptions of the work, never claimed complete.
  lines.push({
    id: "decompose",
    kind: "stage",
    label: "Decomposing the diff into reviewable chunks",
  });
  lines.push({ id: "budget", kind: "stage", label: "Checking the invocation budget" });
  lines.push({
    id: "angles",
    kind: "stage",
    label: "Drafting the review angles over your changeset",
  });
  lines.push({ id: "order", kind: "stage", label: "Ordering the chunks for comprehension" });
  lines.push({ id: "narrate", kind: "stage", label: "Writing the roll-up narration" });

  return lines;
}

/** Respect the user's reduced-motion setting (jsdom-safe: no matchMedia ⇒ motion off). */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(query.matches);
    const onChange = () => setReduce(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduce;
}

const REVEAL_INTERVAL_MS = 480;

/**
 * The live-narration feed shown while the AI review generates (replacing the bare
 * "Running…" line). Reveals the real feed lines one at a time so it reads as a live
 * narration; the frontier line pulses to say the engine is still working. With
 * reduced motion, every line is present at once and nothing animates. The changeset
 * facts are always rendered on the first frame, so the surface is never blank.
 */
export function GenerationNarration({ patchset }: { patchset?: Patchset }) {
  const lines = useMemo(() => narrationFeedLines(changesetShape(patchset)), [patchset]);
  const reduceMotion = usePrefersReducedMotion();
  const [revealed, setRevealed] = useState(1);

  useEffect(() => {
    if (reduceMotion || lines.length <= 1) {
      setRevealed(lines.length);
      return;
    }
    setRevealed(1);
    const timer = window.setInterval(() => {
      setRevealed((count) => {
        if (count >= lines.length) {
          window.clearInterval(timer);
          return count;
        }
        return count + 1;
      });
    }, REVEAL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [lines, reduceMotion]);

  const shown = lines.slice(0, Math.max(1, revealed));
  const activeIndex = shown.length - 1;

  return (
    <section
      className="gen-narration"
      role="status"
      aria-live="polite"
      aria-label="AI review progress"
    >
      <p className="eyebrow">AI REVIEW</p>
      <h2>Watching the review come together</h2>
      <ol className="gen-feed">
        {shown.map((line, index) => (
          <li
            key={line.id}
            className={`gen-line gen-${line.kind}${index === activeIndex ? " is-active" : ""}`}
          >
            <span className="gen-dot" aria-hidden="true" />
            <span className="gen-body">
              <span className="gen-label">{line.label}</span>
              {line.detail ? <span className="gen-detail">{line.detail}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <p className="gen-foot">
        Rennet reads your diff and drafts the review over your own subscription, on your machine.
      </p>
    </section>
  );
}
