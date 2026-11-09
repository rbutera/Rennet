import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SourceControlToolIdSchema } from "../session";
import { detectedSourceControlToolSchema } from "../wire";
import { parseCommandInput, parseCommandOutput } from "./index";

/**
 * `tools.install` `rejoin` (review-preparation-reliability, source-control-tooling spec).
 *
 * The schemas a client that predates `rejoin` decodes with, copied verbatim from the protocol
 * as it stood before (commit 49129e001). `rejoin` is additive on the input, and the one new
 * answer — `{ outcome: "unknown" }` — is something only a rejoin request can receive, so the
 * older client must keep parsing everything it can still be sent.
 */
const OLD_COMMAND_ID = z.uuid();
const OLD_LOCUS = z.union([
  z.object({ kind: z.literal("host") }),
  z.object({ kind: z.literal("wsl"), distro: z.string().min(1) }),
]);
const OLD_INPUT = z.object({
  tool: SourceControlToolIdSchema,
  locus: OLD_LOCUS,
  commandId: OLD_COMMAND_ID,
});
const OLD_RESULT = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("installed"),
    command: z.string().min(1),
    output: z.string(),
    probe: detectedSourceControlToolSchema,
  }),
  z.object({
    status: z.literal("failed"),
    command: z.string().min(1),
    message: z.string().min(1),
    failedCommand: z.string().min(1),
    exitCode: z.number().int().nullable(),
    cancelled: z.literal(true).optional(),
    output: z.string(),
    probe: detectedSourceControlToolSchema,
  }),
  z.object({
    status: z.literal("manual"),
    command: z.string().min(1),
    docsUrl: z.string().min(1),
    probe: detectedSourceControlToolSchema,
  }),
]);
const OLD_OUTPUT = z.object({ result: OLD_RESULT });

const COMMAND_ID = "0b6f3c1e-8a4d-4f6b-9c2a-1d3e5f7a9b0c";
const PROBE = { id: "git-lfs", version: "3.7.0", status: "available", detail: "" } as const;
const VERDICTS = [
  { result: { status: "installed", command: "brew install git-lfs", output: "", probe: PROBE } },
  {
    result: {
      status: "failed",
      command: "brew install git-lfs",
      message: "Git LFS couldn't be installed.",
      failedCommand: "brew install git-lfs",
      exitCode: 1,
      output: "Error",
      probe: { ...PROBE, version: null, status: "not-installed" },
    },
  },
  {
    result: {
      status: "manual",
      command: "sudo apt-get install git-lfs",
      docsUrl: "https://git-lfs.com",
      probe: PROBE,
    },
  },
] as const;

describe("tools.install rejoin, against a client that predates it", () => {
  it("an old request (no rejoin) still parses, and reads as not a rejoin", () => {
    const old = { tool: "git-lfs", locus: { kind: "host" }, commandId: COMMAND_ID };
    expect(OLD_INPUT.safeParse(old).success).toBe(true);
    const parsed = parseCommandInput("tools.install", old);
    expect(parsed.rejoin).toBeUndefined();
    expect(parseCommandInput("tools.install", { ...old, rejoin: true }).rejoin).toBe(true);
    // Only `true` means anything: there is no "rejoin: false" mode to get subtly wrong.
    expect(() => parseCommandInput("tools.install", { ...old, rejoin: false })).toThrow();
  });

  it("every verdict the daemon can send a non-rejoin request parses under the old schema", () => {
    for (const verdict of VERDICTS) {
      const sent = parseCommandOutput("tools.install", verdict);
      expect(sent).toEqual(verdict);
      expect(OLD_OUTPUT.safeParse(sent).success).toBe(true);
    }
  });

  it("the unknown outcome parses now, and would FAIL the old schema — so only rejoin may get it", () => {
    const unknown = parseCommandOutput("tools.install", { outcome: "unknown" });
    expect(unknown).toEqual({ outcome: "unknown" });
    expect(OLD_OUTPUT.safeParse(unknown).success).toBe(false);
  });
});
