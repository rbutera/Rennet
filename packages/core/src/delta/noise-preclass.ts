import type { HunkId } from "@rennet/protocol";
import { isLockfile } from "../file-classification";
import type { HunkIndex } from "./hunk-index";

/**
 * The mechanically-certain noise rules. Deliberately tiny: only classifications
 * a path alone decides beyond doubt belong here — the model judges the
 * remainder in the noise lens draft (#464 dec. 2). Do not add formatting or
 * import-order heuristics; those are judgements, not facts.
 */
export const NOISE_PRECLASS_RULES = ["lockfile", "generated-scaffold", "generated-output"] as const;
export type NoisePreclassRule = (typeof NOISE_PRECLASS_RULES)[number];

/**
 * One deterministic pre-classification: this hunk is a noise candidate, and
 * `rule` records which mechanical rule judged it — the "how it was judged"
 * chip the Noise lens renders, kept apart from model verdicts.
 */
export interface NoisePreclassFact {
  readonly hunkId: HunkId;
  readonly rule: NoisePreclassRule;
  readonly reason: string;
}

/** OpenSpec's generated scaffold stamp (R22: noise, not a spec artifact). */
function isScaffoldStamp(path: string): boolean {
  return path.endsWith(".openspec.yaml");
}

/**
 * The approved generated-output globs, and ONLY those: a `dist/` path segment,
 * minified bundles (`*.min.*`), and JS/CSS sourcemaps. Deliberately narrower
 * than decomposition's `isGeneratedPath` — that helper's `build/`, `generated/`
 * and bare-`.map` matches sweep up hand-authored files (`build/config.ts`,
 * `routes.map`), which is a judgement, not a mechanical certainty.
 */
function isGeneratedOutput(path: string): boolean {
  const segs = path.split("/");
  const base = (segs[segs.length - 1] ?? path).toLowerCase();
  if (segs.slice(0, -1).some((s) => s.toLowerCase() === "dist")) return true;
  if (/\.min\./.test(base)) return true;
  return /\.(js|css|mjs|cjs)\.map$/.test(base);
}

function ruleFor(path: string): { rule: NoisePreclassRule; reason: string } | null {
  if (isLockfile(path)) return { rule: "lockfile", reason: `lockfile: ${path}` };
  if (isScaffoldStamp(path)) {
    return { rule: "generated-scaffold", reason: `generated scaffold stamp: ${path}` };
  }
  if (isGeneratedOutput(path))
    return { rule: "generated-output", reason: `generated output: ${path}` };
  return null;
}

/**
 * Classify the hunk index's mechanically-certain noise candidates. Pure and
 * deterministic: same index, same facts, in hunk order. A hunk no rule fires
 * on yields no fact — absence means "a model must judge this", never "signal".
 */
export function preclassifyNoise(index: HunkIndex): NoisePreclassFact[] {
  const facts: NoisePreclassFact[] = [];
  for (const hunk of index.hunks) {
    const fired = ruleFor(hunk.path);
    if (fired) facts.push({ hunkId: hunk.id, ...fired });
  }
  return facts;
}
