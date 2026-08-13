// @vitest-environment happy-dom
//
// SLICE 5 — the persistence-to-publish PRIVACY proof at the REAL app boundary (#251).
//
// Conversation state is now DURABLE: `FileThreadStore` persists threads to disk and the
// conversation host RESTORES them on mount via `review.reattach`. That is a new road
// from a private place (the store) to the publish boundary. This mounts the WHOLE
// `RennetApp`, lets the host re-attach a private conversation THROUGH THE REAL SEAM (the
// same `review.reattach` invoke the host fires), drives a REAL hold-to-sign of an
// UNRELATED disposition, and proves nothing of the restored conversation reaches the
// signed `publish.review` comments, its payload, or the paper the human signs.
//
// ⚠️ THE CORPUS COMES FROM THE STORE, NOT THE SCREEN (issue #36 F-A, fourth round). A
// DOM-derived corpus cannot see a body that is persisted but not currently MOUNTED —
// exactly the gap this slice opens. So the forbidden set is walked out of the persisted
// thread payload the re-attach seam returns (the store's `loadThreads` output shape,
// bound to real on-disk persistence by `packages/adapters/src/file-thread-store.test.ts`,
// which proves those bodies survive a write→read round-trip verbatim). Coverage grows
// with the conversation, not with an enumerated needle list.
import type {
  CommandInput,
  CommandOutput,
  PersistedThreadWire,
  RennetBridge,
} from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { fireEvent, mount, waitFor } from "./test/dom";

const review: Review = {
  id: "review",
  repositoryRoot: "/code/rennet",
  activePatchsetId: "patch-one",
  dispositions: [],
  status: "current",
  patchsets: [
    {
      id: "patch-one",
      createdAt: "2026-08-08T00:00:00.000Z",
      repository: {
        id: "repository",
        root: "/code/rennet",
        commonDir: "/code/rennet/.git",
        baseRef: "main",
        baseOid: "1111111111111111",
        headOid: "2222222222222222",
      },
      files: [
        {
          path: "src/x.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: "+const reviewed = true;",
        },
      ],
      rawDiff: "+const reviewed = true;",
      byteLength: 24,
      truncated: false,
    },
  ],
};

// A distinct canary in every persisted body — human (`you`) and model (`harness`), two
// threads, multiple turns. ⚠️ Q2 carries a quote, a backslash and a newline: exactly what
// `JSON.stringify` escapes, so a raw serialised-payload search would miss it. The human
// halves (q*) are the ones that would hold a pasted credential.
const Q1 = "CANARY_Q1_HUMAN::must-never-be-published";
const A1 = "CANARY_A1_HARNESS::must-never-be-published";
const Q2 = 'CANARY_Q2_HUMAN "quoted secret" back\\slash\nnewline::must-never-be-published';
const A2 = "CANARY_A2_HARNESS_LATER::must-never-be-published";
const Q3 = "CANARY_Q3_HUMAN_SUBTHREAD::must-never-be-published";
const A3 = "CANARY_A3_HARNESS_SUBTHREAD::must-never-be-published";

// The persisted private conversation the re-attach seam restores — the shape a real
// `FileThreadStore.loadThreads` returns (an interrupted turn would carry an empty body;
// omitted here so every corpus member is a real leakable body).
const PERSISTED: PersistedThreadWire[] = [
  {
    threadId: "th-main",
    anchor: { kind: "chunk", label: "src/x.ts", key: "chunk|src/x.ts" },
    messages: [
      { id: "m0", author: "you", body: `why fail open? ${Q1}` },
      { id: "m1", author: "harness", model: "Claude", body: `Because the plan says so. ${A1}` },
      { id: "m2", author: "you", body: `and then what? ${Q2}` },
      { id: "m3", author: "harness", model: "Claude", body: `It retries once. ${A2}` },
    ],
  },
  {
    threadId: "th-fragment",
    anchor: { kind: "fragment", label: "src/x.ts · reply", key: "fragment|th-main|m1" },
    messages: [
      { id: "m4", author: "you", body: `what do you mean? ${Q3}` },
      { id: "m5", author: "harness", model: "Claude", body: `The bucket, precisely. ${A3}` },
    ],
  },
];

/** The forbidden corpus, DERIVED FROM THE STORE OUTPUT (the re-attach payload), never
 *  the DOM: every non-empty body of every message of every restored thread. */
function storeCorpus(threads: readonly PersistedThreadWire[]): string[] {
  return threads
    .flatMap((thread) => thread.messages.map((message) => message.body))
    .filter((body) => body.trim() !== "");
}

function harness() {
  const publishCalls: CommandInput<"publish.review">[] = [];
  const reattach = { called: 0 };
  const invoke = async (name: string, _input: unknown): Promise<unknown> => {
    if (name === "review.canvases") return { canvases: demoCanvases(), elementDiffs: {} };
    // The REAL re-attach seam: the conversation host invokes this on mount, and this
    // returns exactly what the store would — the persisted private conversation. Counting
    // the call proves the app PULLED the private content into its reach (not that it merely
    // sat unused on disk), which is what makes the non-leak below load-bearing.
    if (name === "review.reattach") {
      reattach.called += 1;
      return { threads: PERSISTED, inFlight: [] };
    }
    if (name === "publish.review") {
      publishCalls.push(_input as CommandInput<"publish.review">);
      const output: CommandOutput<"publish.review"> = {
        dryRun: true,
        request: {
          endpoint: "https://api.github.com/graphql",
          method: "POST",
          body: { query: "mutation {}", variables: {} },
        },
        marker: "a".repeat(64),
        ledger: [],
        outcome: null,
      };
      return output;
    }
    return { review };
  };
  return {
    bridge: { invoke: invoke as unknown as RennetBridge["invoke"] },
    publishCalls,
    reattach,
  };
}

describe("RennetApp — a persisted private conversation never reaches the publish boundary (#251)", () => {
  it("after the app re-attaches the persisted conversation, a signed review carries nothing of it", async () => {
    const { bridge, publishCalls, reattach } = harness();
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".destination-frame")).not.toBeNull());

    // Stage a real, UNRELATED disposition to publish: mark the file read (a comment),
    // pick the other-PR act (`publish.review`).
    fireEvent.click(getByRole("tab", { name: "Files" }));
    fireEvent.click(getByRole("button", { name: "Mark read" }));
    await waitFor(() =>
      expect(container.querySelector(".destination-frame")?.getAttribute("data-staged-count")).toBe(
        "1",
      ),
    );
    fireEvent.click(getByRole("tab", { name: "Review to post" }));
    await waitFor(() =>
      expect(container.querySelector(".destination-frame")?.getAttribute("data-mode")).toBe(
        "other-pr",
      ),
    );

    // Enter the Canvases view so the conversation panel mounts and RE-ATTACHES the persisted
    // private conversation through the real seam — the app pulls the private content into
    // its reach. (Whether the restored threads then render into the DOM is a rendering
    // concern of the host, not of privacy; the proof deliberately does NOT depend on it,
    // because the corpus is the STORE output, not the screen — a persisted body must not
    // leak whether or not it is currently mounted.)
    fireEvent.click(getByRole("tab", { name: "Canvases" }));
    await waitFor(() => expect(container.querySelector(".conversation-panel")).not.toBeNull());
    await waitFor(() => expect(reattach.called).toBeGreaterThanOrEqual(1));

    // Open the draft, stage the comment to ink, freeze the paper, and hold-to-sign.
    fireEvent.click(container.querySelector(".destination-open-draft") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".collation-canvas")).not.toBeNull());
    fireEvent.click(container.querySelector(".collation-item-stage-box") as HTMLInputElement);
    await waitFor(() =>
      expect(container.querySelector<HTMLInputElement>(".collation-item-stage-box")?.checked).toBe(
        true,
      ),
    );
    fireEvent.click(container.querySelector(".collation-sign") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".publish-sheet")).not.toBeNull());
    const sign = container.querySelector<HTMLButtonElement>(".publish-sheet-sign");
    if (!sign) throw new Error("no paper sign control");
    fireEvent.mouseDown(sign);
    await new Promise((resolve) => setTimeout(resolve, 850));
    fireEvent.mouseUp(sign);
    await waitFor(() => expect(publishCalls).toHaveLength(1));

    // The corpus is the STORE's output (the re-attach payload), NOT the mounted DOM —
    // so it covers a persisted body whether or not it rendered.
    const corpus = storeCorpus(PERSISTED);

    // POSITIVE CONTROL: the corpus is non-empty, spans both authors and both threads, and
    // includes the JSON-significant body; and the scan bites (a haystack containing a
    // corpus body is flagged).
    expect(corpus.length).toBeGreaterThanOrEqual(6);
    expect(corpus.some((body) => body.includes(A2))).toBe(true); // a LATER model turn
    expect(corpus.some((body) => body.includes(Q3))).toBe(true); // the second thread
    expect(corpus.some((body) => body === `and then what? ${Q2}`)).toBe(true);
    expect(`prefix ${corpus[0]} suffix`.includes(corpus[0] as string)).toBe(true);

    // THE INVARIANT: no restored body appears in the STRUCTURED outbound. ⚠️ Compare the
    // real values, NEVER `JSON.stringify(call)` — a needle valid on the body is INVALID on
    // the serialised form (Q2's quote/backslash/newline escape). Inspect each
    // `comments[].body` directly and PARSE `payload` before inspecting ITS bodies. The
    // paper is DOM text (untransformed), scanned raw. RED-proof (executed in the sibling
    // apps/desktop test): fold a persisted body into a comment and the structured scan
    // reddens where a `JSON.stringify(...).includes(body)` check stays green.
    const call = publishCalls[0];
    if (!call) throw new Error("no publish.review call recorded");
    const parsedPayload = JSON.parse(call.payload) as { comments: { body: string }[] };
    const sentBodies = [
      ...call.comments.map((comment) => comment.body),
      ...parsedPayload.comments.map((comment) => comment.body),
    ];
    const paperText = container.querySelector(".publish-sheet")?.textContent ?? "";
    for (const body of corpus) {
      for (const sent of sentBodies) expect(sent.includes(body)).toBe(false);
      expect(paperText.includes(body)).toBe(false);
    }
    // A floor check that something WAS published — "nothing leaked" is not "nothing was
    // published" (the unrelated mark-read comment is the sole outbound body).
    expect(call.comments.length).toBeGreaterThanOrEqual(1);
  });
});
