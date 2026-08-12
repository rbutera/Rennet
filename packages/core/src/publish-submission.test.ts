import { describe, expect, it } from "vitest";
import { canonicalPrSubmissionPayload, type ForgePrSubmission } from "./publish-submission";

// The canonical `pr-submission` bytes MUST stay byte-identical to the ui layer's
// `prSubmissionPayload` (`packages/ui/src/canvas/publish.ts`): same `kind`, same
// EXACT field order (kind, title, body, base, head, draft). MAIN round-trips the
// signed payload against these bytes and fails CLOSED on any drift, so this pins the
// cross-layer twin — a change to one copy that is not mirrored here breaks the test.
describe("canonicalPrSubmissionPayload — the MAIN twin of the ui prSubmissionPayload", () => {
  const submission: ForgePrSubmission = {
    title: "Reviewed change",
    body: "## Requested changes\n- `src/x.ts` — fix it",
    base: "main",
    head: "feat/reviewed",
    draft: true,
  };

  it("serialises the exact kind + field order the ui previews and signs", () => {
    expect(canonicalPrSubmissionPayload(submission)).toBe(
      JSON.stringify({
        kind: "pr-submission",
        title: "Reviewed change",
        body: "## Requested changes\n- `src/x.ts` — fix it",
        base: "main",
        head: "feat/reviewed",
        draft: true,
      }),
    );
  });

  it("field order is stable regardless of how the submission object was built", () => {
    // Build the object with a different key insertion order; the canonical bytes are
    // keyed by the explicit field order, not object-key order.
    const shuffled: ForgePrSubmission = {
      draft: false,
      head: "feat/reviewed",
      base: "main",
      body: "b",
      title: "t",
    };
    expect(canonicalPrSubmissionPayload(shuffled)).toBe(
      '{"kind":"pr-submission","title":"t","body":"b","base":"main","head":"feat/reviewed","draft":false}',
    );
  });

  it("the head is carried verbatim — never sliced or transformed (#107)", () => {
    const payload = canonicalPrSubmissionPayload({ ...submission, head: "release/2026-08" });
    expect(JSON.parse(payload).head).toBe("release/2026-08");
  });
});
