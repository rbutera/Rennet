import type { AdmittedDocument } from "@rennet/core";
import type { DecisionRecordBody, DecisionsRunStatus } from "@rennet/protocol";

/**
 * The Decisions lens substrate (issue #137), STUBBED for this wave.
 *
 * The Decisions lens shows the calls the implementer actually made — discerned
 * from the spec, the PR body, and the diff — each a plain-language decision with
 * the evidence chips it was drawn from and a reconstructed why (marked as
 * reconstructed, a starting read, never a claim of fact), grouped by theme. The
 * LIVE decision-extraction runner that reasons over {spec, PR body, diff} is NOT
 * wired yet: it depends on #136's patchset intent-capture (PR title/body + spec
 * snapshots frozen on the patchset), so without those it has only the diff.
 *
 * Rather than invent that backend, this fixture supplies a deterministic set of
 * `decision.record` documents that exercise EVERY state the lens renders — a
 * decision with a spec + PR-body + hunk evidence trio and a reconstructed why
 * naming the alternative not taken; a decision drawn only from the diff with a
 * reconstructed why; and a decision with NO discernible rationale (no `why`) that
 * still renders on its evidence alone rather than inventing a reason. Two themes
 * ("Storage and state", "Failure posture", per prototype frame 08) are keyed by
 * anchored chunk so the existing `projectDecisions` projector groups them.
 *
 * NOTE (issue #137, load-bearing): there is deliberately NO evidenced / mechanical
 * / contestable triage bucket anywhere in this data. Grouping + evidence chips +
 * a reconstructed why is the whole shape; judging a decision is the reviewer's job.
 *
 * These documents FLOW into `buildReviewCanvases` via its `decisionDocs` input,
 * exactly as live decision.record docs will — the boundary here is real, only the
 * producer behind it is a fixture. Live wiring is the follow-up.
 */
export function decisionsRecordFixture(): AdmittedDocument[] {
  const decisions: DecisionRecordBody["decisions"] = [
    {
      decisionId: "dec-per-repo-store",
      // "Storage and state" theme: keyed to the storage chunk.
      anchor: "rennet:chunk/storage",
      title: "Keyed the review store per repository root, not per branch",
      evidence: [
        {
          kind: "spec",
          label: "spec §2.1",
          detail: "The review must survive a force-push and a branch rename.",
        },
        {
          kind: "pr-body",
          label: "PR body",
          detail: "Store lives under the repo's common-dir so worktrees share one review.",
        },
        {
          kind: "hunk",
          label: "sqlite-review-store.ts +18",
          detail: "const key = repository.commonDir; // not headRef",
        },
      ],
      why: {
        reconstructed: true,
        text: "Branch-keying would drop the review the moment the branch is renamed or force-pushed; keying on the repo root is what makes the review survive both.",
      },
      alternatives: [
        "Key per branch ref (simpler, but lost on force-push)",
        "Key per patchset id (loses cross-patchset history)",
      ],
    },
    {
      decisionId: "dec-action-read-state",
      anchor: "rennet:chunk/storage",
      title: "Made read-state action-defined, never scroll-defined",
      evidence: [
        {
          kind: "hunk",
          label: "read-state.ts +7",
          detail: "read only advances on an explicit disposition or open, not on viewport.",
        },
      ],
      // A decision drawn from the diff alone still gets a reconstructed read.
      why: {
        reconstructed: true,
        text: "Scroll-as-read silently marks code seen that the reviewer never engaged with; an action gate keeps 'read' honest.",
      },
      alternatives: [],
    },
    {
      decisionId: "dec-fail-closed-carry",
      // "Failure posture" theme: keyed to the failure chunk.
      anchor: "rennet:chunk/failure",
      title: "Chose fail-closed carry on a truncated patch",
      evidence: [
        {
          kind: "spec",
          label: "spec §4.3",
          detail: "A disposition must never be carried over a patch the tool could not fully read.",
        },
        {
          kind: "hunk",
          label: "carry.ts +42",
          detail: "if (patch.truncated) return refuseCarry(span);",
        },
      ],
      why: {
        reconstructed: true,
        text: "Carrying a span over a patch that was truncated risks re-anchoring it onto the wrong code; refusing the carry is the safe posture when the input is incomplete.",
      },
      alternatives: ["Best-effort re-anchor over the visible portion (risks a silent mis-carry)"],
    },
    {
      decisionId: "dec-import-reorder",
      anchor: "rennet:chunk/failure",
      title: "Left the import reordering in place rather than reverting it",
      evidence: [
        {
          kind: "hunk",
          label: "index.ts +1 −1",
          detail: "import order changed; no symbol added or removed.",
        },
      ],
      // No discernible rationale: the lens must render this on its evidence alone,
      // rather than inventing a reason. `why` is deliberately absent.
      alternatives: [],
    },
  ];
  return [{ docId: "doc-decisions-fixture", docType: "decision.record", body: { decisions } }];
}

/**
 * The honestly-empty case: a review that RAN and discerned no decisions. Distinct
 * from a failed runner — the lens says "ran, nothing discerned", never a silent
 * blank that could be mistaken for a runner that never executed.
 */
export function emptyDecisionsRecordFixture(): AdmittedDocument[] {
  return [];
}

/** The runner ran clean — the honest status paired with an empty decision set. */
export function okDecisionsRunStatus(): DecisionsRunStatus {
  return { status: "ok" };
}

/**
 * The failed-runner case: the decision-extraction runner did not complete. The
 * lens must render this LOUDLY apart from "nothing discerned"; conflating the two
 * is the exact lie the empty-vs-failed distinction refuses.
 */
export function failedDecisionsRunStatus(): DecisionsRunStatus {
  return { status: "failed", reason: "the decision-extraction runner did not report a result" };
}
