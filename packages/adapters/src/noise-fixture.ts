import type { NoiseReview } from "@rennet/types";

/**
 * The Noise lens substrate (issue #34), STUBBED for this wave.
 *
 * The Noise lens groups the low-signal churn a changeset touches — formatting,
 * lockfile regeneration, import reordering, generated output — away from the code
 * that needs eyes, tags each group with HOW it was judged (a deterministic
 * mechanical RULE vs the LLM NOISE JOB), and lets a reviewer pull any group back
 * into the review. Behind the typed boundary the live noise-classification RUNNER
 * (the deterministic mechanical-rules engine + the LLM noise job that classify a
 * real diff) is NOT wired yet.
 *
 * Rather than invent that backend, this fixture supplies a deterministic set that
 * exercises EVERY state the lens renders — groups settled by a mechanical RULE
 * (lockfile, formatting, generated) AND a group settled by the LLM NOISE JOB
 * (import reordering), so both chip types render; a plain-speech one-line summary
 * per group; several inspectable churn items per group (the totality floor: nothing
 * dropped, only collapsed); and — crucially — a DEVIATING line inside the
 * import-order group (an import that actually adds a new symbol) that BREAKS the
 * group's pattern and must EJECT into normal review rather than be suppressed.
 *
 * Live wiring is the follow-up; the boundary here is real.
 */
export function noiseReviewFixture(): NoiseReview {
  return {
    status: "ok",
    groups: [
      {
        groupId: "noise-formatting",
        category: "formatting",
        summary: "Whitespace and formatting only; no code changed.",
        judgedBy: { kind: "rule", rule: "formatting-only" },
        items: [
          { anchor: "rennet:hunk/fmt-app-1", detail: "src/app.tsx — reflowed to the formatter" },
          {
            anchor: "rennet:hunk/fmt-store-1",
            detail: "src/store.ts — trailing whitespace trimmed",
          },
        ],
      },
      {
        groupId: "noise-lockfile",
        category: "lockfile",
        summary: "Dependency graph unchanged; the lockfile was regenerated.",
        judgedBy: { kind: "rule", rule: "lockfile" },
        items: [
          { anchor: "rennet:hunk/lock-1", detail: "pnpm-lock.yaml — integrity hashes refreshed" },
          { anchor: "rennet:hunk/lock-2", detail: "pnpm-lock.yaml — resolution order re-sorted" },
        ],
      },
      {
        groupId: "noise-import-order",
        category: "import-order",
        summary: "Imports reordered; no symbol added or removed.",
        // The AMBIGUOUS remainder — an LLM noise-job call, not a mechanical rule.
        judgedBy: { kind: "noise-job", model: "Claude" },
        items: [
          { anchor: "rennet:hunk/import-a-1", detail: "src/a.ts — imports sorted alphabetically" },
          { anchor: "rennet:hunk/import-b-1", detail: "src/b.ts — grouped std before local" },
          // The deviating line: this "import" actually adds a NEW symbol, so it breaks
          // the group's no-symbol-change pattern and MUST eject into normal review.
          {
            anchor: "rennet:hunk/import-c-1",
            detail:
              "src/c.ts — added `import { chargeCard }` (a real new dependency, not a reorder)",
            deviates: true,
          },
        ],
      },
      {
        groupId: "noise-generated",
        category: "generated",
        summary: "Generated output regenerated from source; not hand-edited.",
        judgedBy: { kind: "rule", rule: "generated" },
        items: [
          {
            anchor: "rennet:hunk/gen-1",
            detail: "dist/schema.json — rebuilt from the source schema",
          },
        ],
      },
    ],
  };
}

/**
 * The honestly-empty case: a review that RAN and grouped nothing as noise. Distinct
 * from a failed runner — the lens says "ran clean", never a silent all-clear masking
 * a runner that never executed.
 */
export function emptyNoiseReviewFixture(): NoiseReview {
  return { status: "ok", groups: [] };
}

/**
 * The failed-runner case: the noise-classification runner did not complete. The lens
 * must render this LOUDLY apart from "nothing grouped"; conflating the two is the
 * exact lie the empty-vs-failed distinction refuses.
 */
export function failedNoiseReviewFixture(): NoiseReview {
  return { status: "failed", reason: "the noise-classification runner did not report a result" };
}
