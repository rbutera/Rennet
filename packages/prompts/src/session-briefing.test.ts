import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  renderSessionBriefing,
  SESSION_BRIEFING_FILE,
  SESSION_BRIEFING_MAX_BYTES,
  SESSION_BRIEFING_TOOL_NAME_CAP,
  type SessionBriefingInput,
} from "./index.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const fixedBriefing = readFileSync(join(srcDir, SESSION_BRIEFING_FILE), "utf8");
const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

/** The tool set the session thread is expected to hold (`AGENT_EXPOSED`, projected). */
const TOOL_NAMES = [
  "app_session_list",
  "app_review_load",
  "app_board_read",
  "app_patchset_readSpan",
  "app_patchset_readEvidence",
  "app_ask_stage",
  "app_ask_edit",
  "app_ask_unstage",
  "app_round_dispatch",
  "app_review_draftPrBody",
] as const;

/**
 * A reviewed change, in the shape the briefing must NOT carry: file paths, diff hunks and
 * the boards a seat drafted over them. The fixture exists so the absence assertions have
 * something real to look for — a briefing that leaks is a briefing that repeats one of
 * these strings.
 */
interface ChangeFixture {
  readonly files: readonly { readonly path: string; readonly hunk: string }[];
  readonly board: readonly { readonly id: string; readonly title: string }[];
}

function changeFixture(fileCount: number): ChangeFixture {
  return {
    files: Array.from({ length: fileCount }, (_unused, index) => ({
      path: `packages/server/src/app/generated-${index}.ts`,
      hunk: `@@ -1,4 +1,9 @@\n+export const bearer${index} = process.env.RENNET_APP_BEARER;`,
    })),
    board: Array.from({ length: fileCount }, (_unused, index) => ({
      id: `el_${index}`,
      title: `Bearer ${index} read from the environment`,
    })),
  };
}

interface LeakOptions {
  /** Splice one board element's title into the FIXED text, the way a prompt edit would. */
  readonly leakBoardElement?: boolean;
  /** Splice it into a dynamic list, the way a new unbounded interpolation would. */
  readonly leakThroughTools?: boolean;
  /** Let the change's size reach the render, the way an inventory line would. */
  readonly leakInventory?: boolean;
}

/**
 * The honest mapping from a reviewed change to a briefing input: it keeps the capture's
 * IDENTITY and drops everything derived from the change. `LeakOptions` are the controls —
 * each one is a plausible future edit, and each must redden the assertion it is aimed at.
 */
function briefingFor(change: ChangeFixture, leak: LeakOptions = {}): string {
  const element = change.board[0];
  const input: SessionBriefingInput = {
    briefing:
      leak.leakBoardElement === true && element !== undefined
        ? `${fixedBriefing}\n\nFlagged says: ${element.title}`
        : fixedBriefing,
    patchset: {
      kind: "branch",
      branch: "feat/session-thread-briefing",
      baseOid: "807bcfeb1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f",
      headOid: "51d49cbb0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d",
      diffCommand:
        "git diff 807bcfeb1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f...51d49cbb0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d",
    },
    contextDir:
      leak.leakInventory === true
        ? `.rennet/context/ses_01HZ-${change.files.length}-files`
        : ".rennet/context/ses_01HZ",
    toolNames:
      leak.leakThroughTools === true && element !== undefined
        ? [...TOOL_NAMES, element.title]
        : [...TOOL_NAMES],
  };
  return renderSessionBriefing(input);
}

describe("renderSessionBriefing", () => {
  it("stays under the ceiling and names the patchset, the context directory and the tools", () => {
    const rendered = briefingFor(changeFixture(95));

    // The ceiling covers the WHOLE append, because the append is a prefix re-read on every
    // round trip of every turn for the thread's life. Measured with the shipped fixed text:
    // 2,559 B fixed + the review's lines.
    expect(bytes(rendered), "rendered briefing bytes").toBeLessThanOrEqual(
      SESSION_BRIEFING_MAX_BYTES,
    );

    // The patchset identity, and the ONE command that reads the change from the checkout.
    expect(rendered).toContain("- Patchset: branch `feat/session-thread-briefing`");
    expect(rendered).toContain("base 807bcfeb1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f");
    expect(rendered).toContain("head 51d49cbb0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d");
    expect(rendered).toContain(
      "`git diff 807bcfeb1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f...51d49cbb0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d`",
    );
    // The context directory, in the sentence the lens seats get: an index, nothing inline.
    expect(rendered).toContain("`.rennet/context/ses_01HZ/`");
    expect(rendered).toContain("its `README.md` indexes every file there");
    expect(rendered).toContain("Nothing is sent to you inline");
    // The tools actually attached, every one of them.
    for (const name of TOOL_NAMES) {
      expect(rendered, `tool ${name}`).toContain(`\`${name}\``);
    }
    // The fixed half rides in whole — it is the map the dynamic lines hang off.
    expect(rendered).toContain("You are the conversation of one Rennet review session");
    expect(rendered).toContain("## This review");
  });

  it("names a pull request by number, and drops the context line when there is no directory", () => {
    const rendered = renderSessionBriefing({
      briefing: fixedBriefing,
      patchset: {
        kind: "pr",
        prNumber: 943,
        branch: "feat/marketing-lens-sections",
        baseOid: "807bcfeb",
        headOid: "19abfee6",
        diffCommand: "git diff 807bcfeb...19abfee6",
      },
      toolNames: [...TOOL_NAMES],
    });
    expect(rendered).toContain("- Patchset: pull request #943 on `feat/marketing-lens-sections`");
    // A chat-only session has no context directory yet, and the briefing says nothing
    // about one rather than naming a path that is not there.
    expect(rendered).not.toContain("context directory");
    expect(bytes(rendered)).toBeLessThanOrEqual(SESSION_BRIEFING_MAX_BYTES);
  });

  it("renders the same bytes for a ninety-five-file change as for a one-file change", () => {
    const small = briefingFor(changeFixture(1));
    const large = briefingFor(changeFixture(95));

    expect(large).toBe(small);
    expect(bytes(large), "bytes for 95 files").toBe(bytes(small));

    // Positive control. The assertion above is constructed from two inputs the mapping
    // makes identical, so on its own it could not fail — which is the first of the three
    // green lies. Let one size-dependent fact through the SAME mapping and it reddens.
    const leaky = briefingFor(changeFixture(95), { leakInventory: true });
    expect(leaky).not.toBe(briefingFor(changeFixture(1), { leakInventory: true }));
  });

  it("carries no hunk, no file path and no board element from the change", () => {
    const change = changeFixture(95);
    const rendered = briefingFor(change);

    const leaks = (text: string): string[] => [
      ...(text.includes("@@ -") ? ["a diff hunk header"] : []),
      ...change.files.filter((file) => text.includes(file.path)).map((file) => file.path),
      ...change.board.filter((element) => text.includes(element.title)).map(({ id }) => id),
    ];
    expect(leaks(rendered), "the briefing is a map, not content").toEqual([]);

    // Positive controls, one per door a leak could come through. Without them this is an
    // absence assertion over a text that simply never mentioned the change.
    expect(leaks(briefingFor(change, { leakBoardElement: true })), "leak via fixed text").toEqual([
      "el_0",
    ]);
    expect(leaks(briefingFor(change, { leakThroughTools: true })), "leak via a tool list").toEqual([
      "el_0",
    ]);
    // What these assertions CANNOT catch: a leak paraphrased rather than copied, and a
    // leak short enough to be cut by a per-field cap before it reaches the text. The caps
    // are pinned below; paraphrase is what review is for.
  });

  it("caps every interpolation and says honestly what it left out", () => {
    const rendered = renderSessionBriefing({
      briefing: fixedBriefing,
      patchset: {
        kind: "branch",
        branch: `feat/${"long-".repeat(2_000)}end`,
        baseOid: "0".repeat(4_000),
        headOid: "1".repeat(4_000),
        diffCommand: `git diff ${"2".repeat(4_000)}`,
      },
      contextDir: `.rennet/context/${"deep/".repeat(2_000)}`,
      toolNames: Array.from({ length: 500 }, (_unused, index) => `app_${"x".repeat(300)}_${index}`),
    });

    expect(bytes(rendered), "a pathological input still fits").toBeLessThanOrEqual(
      SESSION_BRIEFING_MAX_BYTES,
    );
    // Fitting is not enough: the patchset line is the one line the thread cannot work
    // without, and the per-field caps are what keep it. Without them the line runs past
    // the whole budget and `boundedJoin` drops it — the briefing would still fit, and
    // would no longer say which change it is about. (Control: remove the diff-command
    // cap in `renderSessionBriefing` and these two assertions redden while the byte
    // assertion above stays green, which is why they are separate.)
    expect(rendered, "the patchset line survives").toContain("- Patchset: branch `feat/long-");
    expect(rendered, "the base oid survives").toContain("base 0000");
    // Every cut carries its marker, so nothing reads as complete when it is not.
    expect(rendered).toContain("…");
    // Either the tool list was cut at its count cap and said so, or the whole line went
    // over the remaining budget and `boundedJoin` said that instead. Both are honest; the
    // one thing that may not happen is a silent truncation.
    expect(
      rendered.includes("more attached but not listed here") ||
        rendered.includes("omitted (byte cap)"),
      "an honest marker for what was left out",
    ).toBe(true);
  });

  it("lists the tool-name cap's worth and counts the remainder", () => {
    const rendered = renderSessionBriefing({
      briefing: "# Stub briefing",
      patchset: {
        kind: "branch",
        branch: "main",
        baseOid: "aaa1111",
        headOid: "bbb2222",
        diffCommand: "git diff aaa1111...bbb2222",
      },
      toolNames: Array.from({ length: SESSION_BRIEFING_TOOL_NAME_CAP + 7 }, (_u, i) => `app_t${i}`),
    });
    expect(rendered).toContain(`\`app_t${SESSION_BRIEFING_TOOL_NAME_CAP - 1}\``);
    expect(rendered).not.toContain(`\`app_t${SESSION_BRIEFING_TOOL_NAME_CAP}\``);
    expect(rendered).toContain("…and 7 more attached but not listed here");
  });

  it("says so when no tools are attached", () => {
    // An honest empty rather than a dangling "Rennet tools on this thread:" — the thread
    // can still read the checkout, and the line it reads must match what it holds.
    const rendered = renderSessionBriefing({
      briefing: "# Stub briefing",
      patchset: {
        kind: "branch",
        branch: "main",
        baseOid: "aaa1111",
        headOid: "bbb2222",
        diffCommand: "git diff aaa1111...bbb2222",
      },
      toolNames: [],
    });
    expect(rendered).toContain("- Rennet tools on this thread: none attached.");
  });
});
