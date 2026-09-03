import type { LensBoard } from "@rennet/protocol";
import { annotation, board, callout, codeRef, orderStep, prose, section } from "./helpers";

// Sequence lens — a ground-up reading order over the change. The walk's stops are
// `order_step` elements spanning cited code; the stops themselves render prose + code.
export const sequenceBoard: LensBoard = board("sequence", "gen1", "sequence-gen1", [
  section(
    "walk",
    "The Walk, Ground-Up",
    "Start at the record shape, then the emit points, then the daemon sink, then the tests.",
    [
      orderStep("os-record", {
        title: "The shape of an observation, secret-free by construction",
        span: "cr-record",
        children: ["record-prose"],
      }),
      orderStep("os-emit", {
        title: "Emit at every outcome, and refuse to retry the network case",
        span: "cr-emit",
      }),
      orderStep("os-sink", {
        title: "Wire the sink at the composition boundary",
        span: "cr-sink",
      }),
    ],
    {
      refs: [
        codeRef("cr-record", "packages/adapters/src/github-auth.ts", 53, 63),
        codeRef("cr-emit", "packages/adapters/src/github-auth.ts", 244, 261),
        codeRef("cr-sink", "packages/server/src/create-server.ts", 617, 626),
      ],
    },
  ),
  section(
    "record-shape",
    "The Shape of an Observation",
    "`RefreshLogRecord` is the type every refresh observation takes; no field on it can hold a credential.",
    [
      prose(
        "record-prose",
        "Everything else in this change either produces or consumes one record, so the record comes first. `RefreshLogRecord` is a single refresh observation, and its safety is structural — no field on the type can hold a token, a refresh token, or a client secret.",
      ),
      annotation(
        "record-anno",
        "cr-tokenkind",
        'The `?? "token"` fallback carries the whole safety property. An unrecognized value collapses to a fixed constant, so `tokenKind("customerSecret_body")` is `"token"`, never the `"customerSecret_"` slice.',
      ),
    ],
    { refs: [codeRef("cr-tokenkind", "packages/adapters/src/github-auth.ts", 82, 95)] },
  ),
  section(
    "network-branch",
    "Refuse to Retry the Network Case",
    "The network branch only observes and propagates — no retry, because a post-send replay could double a rotation.",
    [
      prose(
        "net-prose",
        "`refreshAndPersist` is the one place that produces records. A network error logs `network` and rethrows — the outcome the change deliberately does not retry.",
      ),
      callout(
        "net-callout",
        "warn",
        "The no-retry choice is what carries this change. The shared transport already retries a connect-phase blip once, replay-safely. A retry here would key off `isGitHubNetworkError`, which also matches post-send errors where the pair may already be rotated — replaying then burns the session.",
      ),
    ],
  ),
]);

/**
 * Round 1's addressed account, told as the newest chapter of the walk (delta `new`),
 * so the Sequence tab dot lights until the section is opened. Each returned round
 * appends one of these at the bottom of Sequence.
 */
const round1Addressed = section(
  "g2-addressed",
  "Round 1 · Addressed",
  "Every refresh exit now writes a terminal record. The missing-outcome finding is closed.",
  [
    prose(
      "g2-prose",
      "`refreshAndPersist` now writes a secret-free terminal record on the two exits that previously left only `attempt` — the non-decline exchange error, and the post-rotation persistence failure. daemon.log no longer stops at `phase=attempt`, so a crash and a real outcome are now distinguishable.",
    ),
    callout(
      "g2-callout",
      "info",
      "The persistence-failure exit gets the same treatment: it writes a `failed` record before the throw escapes, so a rotation the store dropped is no longer a silent dead session.",
    ),
  ],
  { delta: "new", refs: [codeRef("cr-g2", "packages/adapters/src/github-auth.ts", 258, 269)] },
);

/** Sequence, generation 2 (after round 1): the walk plus round 1's chapter. */
export const sequenceGen2Board: LensBoard = {
  ...sequenceBoard,
  generation: "gen2",
  boardId: "sequence-gen2",
  sections: [...sequenceBoard.sections, round1Addressed.entry],
  elements: [...sequenceBoard.elements, ...round1Addressed.elements],
};
