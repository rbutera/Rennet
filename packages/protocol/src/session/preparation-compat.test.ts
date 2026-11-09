import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkProtocolCompatibility } from "../index";
import { LensLaneSchema, type SessionPreparation } from "./model";
import {
  commandOutputForProtocol,
  PREPARATION_STATES_PROTOCOL_VERSION,
  preparationForProtocol,
  progressEventForProtocol,
} from "./preparation-compat";
import { MIN_COMPATIBLE_PROTOCOL_VERSION, PROTOCOL_VERSION } from "./wire";

/**
 * The preparation schema a version-3 client decodes with, copied verbatim from the protocol
 * as it stood before version 4 (commit 7582869ce). A closed union: an unknown `status` or
 * `stage` fails the whole value, and with it the whole `session.list` answer.
 */
const V3_ID = z.string().min(1);
const V3_SESSION_PREPARATION = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("capturing"),
    step: z.enum(["resolving-repository", "capturing-change"]),
  }),
  z.object({ status: z.literal("drafting"), reviewId: V3_ID, lanes: z.array(LensLaneSchema) }),
  z.object({
    status: z.literal("failed"),
    stage: z.enum(["capture", "boards"]),
    reason: z.string().min(1),
    reviewId: V3_ID.optional(),
    lanes: z.array(LensLaneSchema).optional(),
  }),
  z.object({
    status: z.literal("cancelled"),
    stage: z.enum(["capture", "boards"]),
    reviewId: V3_ID.optional(),
    lanes: z.array(LensLaneSchema).optional(),
  }),
]);
/** The part of a v3 `session.list` answer these states live in. */
const V3_SESSION_LIST = z.object({
  sessions: z.array(z.object({ id: z.string(), preparation: V3_SESSION_PREPARATION.optional() })),
});

const NEW_STATES: SessionPreparation[] = [
  { status: "awaiting", kind: "large-file-choice", lfsAvailable: false, reviewId: "rev-1" },
  {
    status: "failed",
    stage: "workspace",
    reason: "Git LFS isn't installed, so this pull request's large files can't be checked out.",
    kind: "tool-missing",
    action: "install",
    tool: "git-lfs",
    detail: "git-lfs: command not found",
    reviewId: "rev-1",
  },
  { status: "cancelled", stage: "workspace", reviewId: "rev-1" },
];

describe("protocol version 4 against a version-3 peer (review-preparation-reliability)", () => {
  it("a version-3 peer still negotiates with this build, so its payloads must stay parseable", () => {
    const thisBuild = { version: PROTOCOL_VERSION, minCompatible: MIN_COMPATIBLE_PROTOCOL_VERSION };
    const v3Peer = { version: 3, minCompatible: 3 };
    expect(checkProtocolCompatibility(thisBuild, v3Peer)).toEqual({ compatible: true });
    expect(checkProtocolCompatibility(v3Peer, thisBuild)).toEqual({ compatible: true });
    expect(PREPARATION_STATES_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });

  it("the new states, sent raw, fail the version-3 schema", () => {
    for (const preparation of NEW_STATES) {
      expect(V3_SESSION_PREPARATION.safeParse(preparation).success).toBe(false);
    }
  });

  it("a session.list answer for a version-3 peer parses under the version-3 schema", () => {
    const output = {
      sessions: [
        ...NEW_STATES.map((preparation, index) => ({ id: `s${index}`, preparation })),
        { id: "plain", preparation: { status: "capturing", step: "resolving-repository" } },
        { id: "none" },
      ],
    };
    expect(V3_SESSION_LIST.safeParse(output).success).toBe(false);
    const downgraded = commandOutputForProtocol(output, 3);
    const parsed = V3_SESSION_LIST.parse(downgraded);
    expect(parsed.sessions.map((row) => row.preparation)).toEqual([
      { status: "capturing", step: "capturing-change" },
      {
        status: "failed",
        stage: "capture",
        reason: "Git LFS isn't installed, so this pull request's large files can't be checked out.",
        reviewId: "rev-1",
      },
      { status: "cancelled", stage: "capture", reviewId: "rev-1" },
      { status: "capturing", step: "resolving-repository" },
      undefined,
    ]);
  });

  it("a single-session answer (`session`) is downgraded the same way, and `null` passes", () => {
    const awaiting = NEW_STATES[0];
    expect(commandOutputForProtocol({ session: { id: "s", preparation: awaiting } }, 3)).toEqual({
      session: { id: "s", preparation: { status: "capturing", step: "capturing-change" } },
    });
    expect(commandOutputForProtocol({ session: null }, 3)).toEqual({ session: null });
    expect(commandOutputForProtocol({ cancelled: true }, 3)).toEqual({ cancelled: true });
  });

  it("a version-4 peer gets every state exactly as it is", () => {
    const output = {
      sessions: NEW_STATES.map((preparation, index) => ({ id: `s${index}`, preparation })),
    };
    expect(commandOutputForProtocol(output, 4)).toBe(output);
    for (const preparation of NEW_STATES) {
      expect(preparationForProtocol(preparation, 4)).toBe(preparation);
    }
  });

  it("install output is not sent to a version-3 peer, whose progress union has no such kind", () => {
    expect(progressEventForProtocol("tool-install-output", 3)).toBe(false);
    expect(progressEventForProtocol("tool-install-output", 4)).toBe(true);
    expect(progressEventForProtocol("repo-prs", 3)).toBe(true);
  });
});
