import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The REAL persistence layer (issue #251): a `FileThreadStore` that writes a private
// conversation to `~/.rennet/threads/<reviewId>.json` and reads it back on re-attach.
import { FileThreadStore } from "@rennet/adapters";
// The REAL outbound-payload construction (the same functions `app.tsx` builds the
// signed `publish.review` bytes from). apps/desktop (`layer:app`) is the ONE layer
// that may import both the adapter store and the ui payload functions, so this is the
// only place a store-vs-payload proof can stand end to end.
import {
  type CollationDraft,
  collationPayload,
  type DispositionWrite,
  ingestWrites,
  publishedItems,
  type ReviewComment,
  reviewComments,
  reviewCommentsPayload,
} from "@rennet/app-ui";
import type { ConversationAnchorWire, PersistedThreadMessageWire } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// SLICE 5 — the persistence-to-publish PRIVACY proof (issue #251).
//
// A private conversation is now DURABLE: `FileThreadStore` persists every thread to
// disk and restores it on re-attach. That is a NEW road from a private place (the
// thread store) to the publish boundary, and this proves it is closed.
//
// THE STRUCTURAL FINDING this test encodes (route (a), reported honestly):
//   The signed outbound is `reviewCommentsPayload(reviewComments(publishedItems(draft)))`.
//   Every one of those functions takes the `CollationDraft` — an ordered list of
//   `CollationItem`s built ONLY from disposition writes (`ingestWrites`) and the #19
//   refinement seam. NONE of them takes, imports, or can reach a `FileThreadStore` or a
//   `PersistedThreadWire`. The store's read output flows solely to `review.reattach`
//   (→ the conversation host); the sole DESIGNED private→published crossing (promotion)
//   is currently unwired in `app.tsx` (`onPromote` is not passed). So the ONLY way a
//   persisted body can reach the payload is if some future edit COPIES its string into
//   a draft item — and because a body is an untyped `string`, that copy cannot be made
//   a compile error. A full type-level guarantee is therefore impossible (the same root
//   reason it was impossible for the live case). This test is the honest guard in its
//   place: derive the forbidden corpus FROM THE STORE and prove none of it reaches the
//   real outbound — coverage that grows with the persisted data, not an enumerated list.
//
// THE STORE-NOT-SCREEN DISCIPLINE (issue #36 F-A, fourth round): a DOM-derived corpus
// cannot see a thread that is persisted but not currently MOUNTED — which is exactly
// the road this slice opens. So the corpus here is walked out of `store.loadThreads`,
// every thread, every message, every non-empty body, human- AND model-authored.
// ─────────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rennet-persist-privacy-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  dirs.length = 0;
});

const ANCHOR: ConversationAnchorWire = {
  kind: "range",
  label: "src/rate/bucket.ts:44-47",
  key: "range|src/rate/bucket.ts|additions|44|47",
  side: "additions",
};

// A DISTINCT canary in every persisted body: human (`you`) and model (`harness`)
// alike, across TWO threads and multiple turns. If ANY appears in the published
// outbound, a persisted private thread leaked.
const Q1 = "CANARY_Q1_HUMAN::must-never-be-published";
const A1 = "CANARY_A1_HARNESS::must-never-be-published";
// ⚠️ Q2 carries JSON-significant characters — a quote, a backslash, a newline — exactly
// what a real pasted secret looks like and exactly what `JSON.stringify` escapes. A raw
// substring search of the serialised payload would MISS this body even if it reached the
// wire verbatim; the structured comparison below does not. This is the human-authored
// half — the one that would hold a pasted credential.
const Q2 = 'CANARY_Q2_HUMAN "quoted secret" back\\slash\nnewline::must-never-be-published';
const A2 = "CANARY_A2_HARNESS_LATER::must-never-be-published";
const Q3 = "CANARY_Q3_HUMAN_SUBTHREAD::must-never-be-published";
const A3 = "CANARY_A3_HARNESS_SUBTHREAD::must-never-be-published";
// A partial answer that was streaming when the process was killed. Slice 4 (#289) means
// an aborted turn persists NO completion and recovers as `interrupted` — and the day that
// recovery carries the partial deltas instead of an empty placeholder, this body is a real
// private fragment. The privacy scan must treat an interrupted turn's body like any other.
const A4 = "CANARY_A4_HARNESS_INTERRUPTED_PARTIAL::must-never-be-published";

const you = (id: string, body: string): PersistedThreadMessageWire => ({ id, author: "you", body });
const harness = (id: string, body: string): PersistedThreadMessageWire => ({
  id,
  author: "harness",
  model: "Orchestrator · Claude",
  body,
});
const streaming = (id: string): PersistedThreadMessageWire => ({
  id,
  author: "harness",
  body: "",
  status: "streaming",
});
// An interrupted turn that DID capture content before the abort (the forward-looking case
// slice 4 opens): status `interrupted`, body non-empty. The corpus must include it.
const interrupted = (id: string, body: string): PersistedThreadMessageWire => ({
  id,
  author: "harness",
  body,
  status: "interrupted",
});

/**
 * Persist a realistic private conversation for `reviewId` via the REAL store: two turns
 * in one thread, a fragment sub-thread as a second thread, a streaming placeholder (which
 * re-attach recovers as an interrupted, empty-bodied turn — the crash-recovery path), and
 * an interrupted turn that DID capture a partial body (slice 4's world). Returns a fresh
 * store over the same directory, i.e. what a NEW process sees on re-attach.
 */
function persistPrivateConversation(reviewId: string): FileThreadStore {
  const dir = tmpDir();
  const store = new FileThreadStore(dir);
  store.upsertThread(reviewId, { threadId: "th-main", anchor: ANCHOR });
  store.putMessage(reviewId, "th-main", you("m0", `why fail open? ${Q1}`));
  store.putMessage(reviewId, "th-main", harness("m1", `Because the plan says so. ${A1}`));
  store.putMessage(reviewId, "th-main", you("m2", `and then what? ${Q2}`));
  store.putMessage(reviewId, "th-main", harness("m3", `It retries once. ${A2}`));
  // A streaming placeholder left behind by a dead process — recovers as interrupted, empty.
  store.putMessage(reviewId, "th-main", streaming("m4"));
  // An interrupted turn carrying a partial private answer — the case that stays a real
  // fragment even though it never completed (slice 4). Scanned like any other body.
  store.putMessage(reviewId, "th-main", interrupted("m4b", `Because the token bucket ${A4}`));
  store.upsertThread(reviewId, {
    threadId: "th-fragment",
    anchor: { ...ANCHOR, kind: "fragment", key: "fragment|th-main|m1", label: "reply" },
  });
  store.putMessage(reviewId, "th-fragment", you("m5", `what do you mean? ${Q3}`));
  store.putMessage(reviewId, "th-fragment", harness("m6", `The bucket, precisely. ${A3}`));
  // A brand-new store over the same dir — durability past the process (a re-attach).
  return new FileThreadStore(dir);
}

/**
 * The forbidden corpus, DERIVED FROM THE STORE (never the screen): every message body of
 * every persisted thread, REGARDLESS OF STATUS (complete, interrupted, whatever) — a
 * turn's privacy does not depend on whether it finished. The only bodies dropped are
 * EMPTY ones, and that is a scan-well-formedness rule, not a status exemption: `"".includes`
 * is true of every string, so an empty needle would flag every outbound body as a false
 * leak. An interrupted turn that captured content is scanned exactly like a completed one.
 */
function persistedCorpus(store: FileThreadStore, reviewId: string): string[] {
  return store
    .loadThreads(reviewId)
    .flatMap((thread) => thread.messages.map((message) => message.body))
    .filter((body) => body.trim() !== "");
}

/**
 * The store bodies that reach a published outbound — inspected STRUCTURALLY, never via
 * `JSON.stringify(...).includes(...)`. Each comment body is compared directly, and the
 * serialised payload is PARSED before its comment bodies are inspected, so a body full
 * of quotes/backslashes/newlines cannot hide behind JSON escaping.
 */
function persistedBodiesInOutbound(
  corpus: readonly string[],
  comments: readonly ReviewComment[],
  payload: string,
): string[] {
  const parsed = JSON.parse(payload) as { comments: { body: string }[] };
  const sentBodies = [
    ...comments.map((comment) => comment.body),
    ...parsed.comments.map((comment) => comment.body),
  ];
  const found: string[] = [];
  for (const secret of corpus) {
    if (sentBodies.some((sent) => sent.includes(secret))) found.push(secret);
  }
  return found;
}

/** An UNRELATED review to publish: a real `request-change` (always ink → publishes)
 *  plus a staged-neutral comment. None of it is conversation content. */
function unrelatedInkDraft(): CollationDraft {
  const writes: DispositionWrite[] = [
    { path: "src/x.ts", type: "request-change", body: "This early-return drops the guard clause." },
    { path: "src/y.ts", type: "request-change", body: "Name the magic number." },
  ];
  return publishedItems(ingestWrites([], writes));
}

describe("issue #251 — persisted conversation content never reaches a published review", () => {
  it("no body of any persisted thread appears in the real publish.review outbound", () => {
    const reviewId = "review-abc";
    const store = persistPrivateConversation(reviewId);

    // The corpus comes from the STORE (round-tripped through disk), not the DOM.
    const corpus = persistedCorpus(store, reviewId);

    // POSITIVE CONTROL over the corpus: it is non-empty, spans BOTH authors and BOTH
    // threads, and includes the JSON-significant human body — so the invariant below is
    // scanning a real, multi-turn, multi-author private conversation.
    expect(corpus.length).toBeGreaterThanOrEqual(6);
    expect(corpus.some((body) => body.includes(Q1))).toBe(true); // human, thread 1
    expect(corpus.some((body) => body.includes(A1))).toBe(true); // model, thread 1
    expect(corpus.some((body) => body.includes(Q3))).toBe(true); // human, thread 2
    expect(corpus.some((body) => body.includes(A3))).toBe(true); // model, thread 2
    expect(corpus.some((body) => body === `and then what? ${Q2}`)).toBe(true); // JSON-significant
    // An INTERRUPTED turn's partial body is in the corpus — privacy is not conditional on
    // a turn completing (slice 4 / #289: an aborted turn recovers as interrupted).
    expect(corpus.some((body) => body.includes(A4))).toBe(true);

    // Build the SAME outbound `app.tsx` signs, from an UNRELATED draft.
    const inkDraft = unrelatedInkDraft();
    const comments = reviewComments(inkDraft);
    const payload = reviewCommentsPayload(comments);

    // THE INVARIANT: not one persisted body reaches the structured outbound (the review
    // comments, the parsed payload's comment bodies, or the ordered collation bytes).
    expect(persistedBodiesInOutbound(corpus, comments, payload)).toEqual([]);
    const collated = JSON.parse(collationPayload(inkDraft)) as { body: string }[];
    for (const secret of corpus) {
      for (const item of collated) expect(item.body.includes(secret)).toBe(false);
    }
    // The published bytes carry ONLY the unrelated dispositions — a floor check that the
    // outbound is non-empty, so "nothing leaked" is not "nothing was published".
    expect(comments).toHaveLength(2);
    expect(payload).toContain("This early-return drops the guard clause.");
  });

  it("the structured scan CATCHES a persisted body folded into a comment, where JSON.stringify would miss it (executed red-proof)", () => {
    const reviewId = "review-leak";
    const store = persistPrivateConversation(reviewId);
    const corpus = persistedCorpus(store, reviewId);
    // The JSON-significant persisted body — the one a naive check misses.
    const secret = corpus.find((body) => body.includes(Q2));
    if (!secret) throw new Error("the JSON-significant persisted body is missing from the corpus");

    // Perform the LITERAL leak: a review comment whose body IS the persisted secret,
    // built and serialised by the SAME functions the app uses. This is the mutation the
    // invariant test is meant to catch — a persisted body reaching the outbound.
    const leakyDraft = ingestWrites(
      [],
      [{ path: "src/x.ts", type: "request-change", body: secret }],
    );
    const leakyComments = reviewComments(publishedItems(leakyDraft));
    const leakyPayload = reviewCommentsPayload(leakyComments);

    // (1) The BROKEN check a reviewer instinctively reaches for MISSES it: JSON escaping
    // turns the quote/backslash/newline into `\"`/`\\`/`\n`, so the raw substring is
    // absent from the serialised form even though the body reached the wire verbatim.
    expect(JSON.stringify({ comments: leakyComments }).includes(secret)).toBe(false);
    expect(leakyPayload.includes(secret)).toBe(false);

    // (2) The STRUCTURED scan this test uses CATCHES it — proving the invariant above
    // is a guard that can go red, not decoration. The single flagged body is the secret.
    expect(persistedBodiesInOutbound(corpus, leakyComments, leakyPayload)).toEqual([secret]);
  });
});
