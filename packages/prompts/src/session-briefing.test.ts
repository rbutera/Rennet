import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  boundedReviewLines,
  capBytes,
  renderSessionBriefing,
  SESSION_BRIEFING_FILE,
  SESSION_BRIEFING_MAX_BYTES,
  SESSION_BRIEFING_REF_MAX_BYTES,
  SESSION_BRIEFING_TOOL_SERVER_MAX_BYTES,
  type SessionBriefingInput,
} from "./index.js";
import { prohibitions } from "./test/prohibitions.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const fixedBriefing = readFileSync(join(srcDir, SESSION_BRIEFING_FILE), "utf8");
const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

/** The tool set the session thread is expected to hold (`AGENT_EXPOSED`, projected). */
const TOOLS = { count: 29, serverName: "rennet_app" } as const;

/** The tool set the session thread is expected to hold (`AGENT_EXPOSED`, projected). Named
 *  here so the leak fixtures and the "never the names" assertion share one list. */
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
      reviewId: "rev-1",
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
    // The COUNT and the server, never the names (the harness's own `tools/list` carries
    // those). A leak fixture therefore has to try it through the SERVER NAME, which is the
    // only free-text field this line still has.
    tools: {
      count: TOOL_NAMES.length,
      serverName:
        leak.leakThroughTools === true && element !== undefined ? element.title : "rennet_app",
    },
  };
  return renderSessionBriefing(input);
}

describe("renderSessionBriefing", () => {
  it("stays under the ceiling and names the patchset, the context directory and the tools", () => {
    const rendered = briefingFor(changeFixture(95));

    // The ceiling covers the WHOLE append, because the append is a prefix re-read on every
    // round trip of every turn for the thread's life. Measured with the shipped fixed text:
    // 2,789 B fixed + 760 B of review lines = 3,549 B, 547 B under the ceiling.
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
    // HOW MANY tools are attached and where they are served — never the names, which the
    // harness's own `tools/list` already delivers with a description each.
    expect(rendered).toContain("10 `app_*` tools on the `rennet_app` MCP server");
    // Not on the DYNAMIC line — the fixed prose hand-names six of them on purpose, which
    // is what teaches the thread what a tool is FOR; the ~900 B enumeration is what went.
    const toolLine = rendered.split("\n").find((line) => line.startsWith("- Rennet tools")) ?? "";
    for (const name of TOOL_NAMES) expect(toolLine, `tool ${name}`).not.toContain(name);
    // The fixed half rides in whole — it is the map the dynamic lines hang off.
    expect(rendered).toContain("You are the conversation of one Rennet review session");
    expect(rendered).toContain("## This review");
  });

  it("names a pull request by number, and drops the context line when there is no directory", () => {
    const rendered = renderSessionBriefing({
      briefing: fixedBriefing,
      patchset: {
        kind: "pr",
        reviewId: "rev-1",
        prNumber: 943,
        branch: "feat/marketing-lens-sections",
        baseOid: "807bcfeb",
        headOid: "19abfee6",
        diffCommand: "git diff 807bcfeb...19abfee6",
      },
      tools: TOOLS,
    });
    expect(rendered).toContain("- Patchset: pull request #943 on `feat/marketing-lens-sections`");
    // A chat-only session has no context directory yet, and the briefing says nothing
    // about one rather than naming a path that is not there.
    expect(rendered).not.toContain("context directory");
    expect(bytes(rendered)).toBeLessThanOrEqual(SESSION_BRIEFING_MAX_BYTES);
  });

  it("is deterministic: two inputs that differ only in the change behind them render the same bytes", () => {
    const small = briefingFor(changeFixture(1));
    const large = briefingFor(changeFixture(95));

    expect(large).toBe(small);
    expect(bytes(large), "bytes for 95 files").toBe(bytes(small));

    // What this proves and what it does not. `briefingFor` is THIS FILE's mapping, so the
    // two inputs are identical by construction and the renderer is what is under test:
    // determinism over equal inputs, no hidden dependence on anything ambient. The claim
    // that PRODUCTION puts nothing change-derived into a `SessionBriefingInput` is a claim
    // about `bindReviewThread`'s mapping, which does not exist yet — cluster 4 asserts it
    // there (tasks.md 4.2), over a real 95-file and a real 1-file review.
    //
    // Positive control for the assertion above, which would otherwise be satisfied by two
    // equal strings and could not fail: let one size-dependent fact through the SAME
    // mapping and the equality reddens.
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

  it("caps each interpolated field inside its own line, with its own marker", () => {
    // One oversized field at a time. A single all-oversized fixture cannot tell a cap that
    // works from a cap that is missing: the over-long line simply vanishes wholesale and
    // the join's omission marker satisfies any "something was cut" assertion. So each case
    // asserts its LINE SURVIVES, its byte bound holds, and the cut is inside that field.
    const base = {
      briefing: "# Stub briefing",
      patchset: {
        kind: "branch",
        reviewId: "rev-1",
        branch: "feat/ordinary",
        baseOid: "aaa1111",
        headOid: "bbb2222",
        diffCommand: "git diff aaa1111...bbb2222",
      },
      tools: TOOLS,
    } as const satisfies SessionBriefingInput;
    const lineOf = (rendered: string, prefix: string): string =>
      rendered.split("\n").find((line) => line.startsWith(prefix)) ?? "";

    const longBranch = renderSessionBriefing({
      ...base,
      patchset: { ...base.patchset, branch: `feat/${"long-".repeat(2_000)}end` },
    });
    const branchLine = lineOf(longBranch, "- Patchset:");
    expect(branchLine, "the branch is cut inside its own backticks").toMatch(
      /^- Patchset: branch `feat\/long-[^\n`]*…` — base aaa1111 → head bbb2222\./,
    );
    expect(bytes(branchLine), "branch line bytes").toBeLessThanOrEqual(
      SESSION_BRIEFING_REF_MAX_BYTES + 200,
    );

    const longOids = renderSessionBriefing({
      ...base,
      patchset: { ...base.patchset, baseOid: "0".repeat(4_000), headOid: "1".repeat(4_000) },
    });
    expect(lineOf(longOids, "- Patchset:"), "both oids are cut in place").toMatch(
      /base 0{10}[0…]*… → head 1{10}[1…]*…\./,
    );

    const longCommand = renderSessionBriefing({
      ...base,
      patchset: { ...base.patchset, diffCommand: `git diff ${"2".repeat(4_000)}` },
    });
    expect(lineOf(longCommand, "- Patchset:"), "the command is cut inside its backticks").toMatch(
      /Read the change with `git diff 2{10}[2]*…`\.$/,
    );

    const longContext = renderSessionBriefing({
      ...base,
      contextDir: `.rennet/context/${"deep/".repeat(2_000)}`,
    });
    const contextLine = lineOf(longContext, "- Your session's");
    expect(contextLine, "the path is cut inside its own backticks").toMatch(
      /^- Your session's context directory is `\.rennet\/context\/(deep\/)+[^`]*…\/`;/,
    );
    expect(contextLine, "and the rest of the sentence survives the cut").toContain(
      "indexes every file there",
    );

    const longServerName = renderSessionBriefing({
      ...base,
      tools: { count: 29, serverName: `rennet_${"x".repeat(300)}` },
    });
    const toolLine = lineOf(longServerName, "- Rennet tools");
    expect(toolLine, "the server name is cut inside its own backticks").toMatch(/`rennet_x+…`/);
    expect(
      bytes(toolLine),
      "and the line's length does not move with the size of the tool surface",
    ).toBeLessThan(SESSION_BRIEFING_TOOL_SERVER_MAX_BYTES + 160);
  });

  it("holds the ceiling for a fixed text that is already over it", () => {
    // The append is the whole thing the provider is handed, so the CEILING is on the
    // return value, not on the parts. Three cases, chosen at and past the edge Codex
    // reproduced: a fixed text that fits, one that fits only until the review's lines are
    // added (3,950 B), and one over the ceiling on its own (5,000 B).
    const review = {
      patchset: {
        kind: "branch",
        reviewId: "rev-1",
        branch: "feat/ordinary",
        baseOid: "aaa1111",
        headOid: "bbb2222",
        diffCommand: "git diff aaa1111...bbb2222",
      },
      contextDir: ".rennet/context/ses_01HZ",
      tools: TOOLS,
    } as const satisfies Omit<SessionBriefingInput, "briefing">;

    for (const fixedBytes of [2_816, 3_950, 5_000]) {
      const rendered = renderSessionBriefing({
        ...review,
        briefing: `# Stub briefing\n\n${"x".repeat(fixedBytes - 18)}`,
      });
      expect(bytes(rendered), `${fixedBytes} B of fixed text`).toBeLessThanOrEqual(
        SESSION_BRIEFING_MAX_BYTES,
      );
      // …and the patchset line is still there, because the review's lines keep their floor
      // whatever the fixed text costs. A ceiling held by deleting the identity of the
      // change under review is not the ceiling this test is about.
      expect(rendered, `${fixedBytes} B keeps the patchset line`).toContain(
        "- Patchset: branch `feat/ordinary`",
      );
    }

    // The last resort: a fixed text with no room left is cut, and says so rather than
    // ending mid-word. This is a programming error the manifest pin catches first.
    const oversized = renderSessionBriefing({ ...review, briefing: "y".repeat(9_000) });
    expect(bytes(oversized)).toBeLessThanOrEqual(SESSION_BRIEFING_MAX_BYTES);
    expect(oversized, "the fixed text carries its own marker").toMatch(/y+…\n\n## This review/);

    // What these cases CANNOT catch: the marker-reservation path inside the join. With
    // three lines whose capped maximum is ~900 B against a 1,024 B floor, the marker always
    // fits and nothing is ever dropped to make room for it, whatever the fixed text does.
    // That contract is pinned directly below instead of pretended at here.
  });

  it("keeps the omission marker inside the budget it was given", () => {
    // `boundedJoin` (the older helper beside it) appends its marker AFTER the budget is
    // spent, so its return is over by the marker's own bytes. This is the half that fixes
    // it, and it is tested directly because `renderSessionBriefing` cannot reach it today.
    // The third line is long enough not to fit, which is what makes an omission happen at
    // all; the first two are what the marker then has to find room beside.
    const lines = ["- one 1111111111", "- two 2222222222", `- three ${"3".repeat(200)}`];
    const marker = "- … 1 more review line omitted (byte cap)";
    // A budget that fits the first two lines but leaves less than the marker needs: the
    // join has to give a line back and re-count. (Control: delete the `while` loop in
    // `boundedReviewLines` and the omitted-count assertion below reddens — the fallback
    // still bounds the bytes, so the byte assertion does not; measured, not assumed.)
    const budget = bytes(`${lines[0]}\n${lines[1]}`) + bytes(`\n${marker}`) - 4;
    const joined = boundedReviewLines(lines, budget);

    expect(bytes(joined), "the join respects the budget it was given").toBeLessThanOrEqual(budget);
    expect(joined, "the first line always survives").toContain(lines[0] as string);
    expect(joined, "and the count is true after the drop").toContain(
      "- … 2 more review lines omitted (byte cap)",
    );
    // A budget too small even for the marker returns something inside it, not a marker.
    expect(bytes(boundedReviewLines(lines, 12)), "a tiny budget").toBeLessThanOrEqual(12);
    // Nothing omitted, nothing said: the marker is not decoration.
    expect(boundedReviewLines(lines, 10_000)).toBe(lines.join("\n"));
  });

  it("forbids nothing, in the RENDERED briefing and not only in the file", () => {
    // The requirement is about what the thread is told, which is the render — the file is
    // half of it and the review's lines are the other half.
    const rendered = briefingFor(changeFixture(95));
    expect(prohibitions(rendered), "the rendered briefing forbids nothing").toEqual([]);
    // Control: the detector fires on the rendered text, not just on a doctored file.
    expect(
      prohibitions(
        renderSessionBriefing({
          briefing: `${fixedBriefing}\n\nYou must\nnot push this branch.`,
          patchset: {
            kind: "branch",
            reviewId: "rev-1",
            branch: "main",
            baseOid: "aaa1111",
            headOid: "bbb2222",
            diffCommand: "git diff aaa1111...bbb2222",
          },
          tools: TOOLS,
        }),
      ),
      "a prohibition wrapped across a line break is still a prohibition",
    ).toHaveLength(1);
  });

  it("carries the tool COUNT and the server, and never the names", () => {
    // The names travel separately and better: the harness's own `tools/list` delivers every
    // name with a description before the first turn runs, so restating them in a
    // system-prompt append is a restatement — of ~900 B, re-read on every round trip of
    // every turn for the thread's life. `renderSessionBriefing` is no longer even GIVEN
    // them, which is the structural version of that rule.
    const rendered = renderSessionBriefing({
      briefing: "# Stub briefing",
      patchset: {
        kind: "branch",
        reviewId: "rev-1",
        branch: "main",
        baseOid: "aaa1111",
        headOid: "bbb2222",
        diffCommand: "git diff aaa1111...bbb2222",
      },
      tools: { count: 29, serverName: "rennet_app" },
    });
    expect(rendered).toContain(
      "- Rennet tools on this thread: 29 `app_*` tools on the `rennet_app` MCP server",
    );
    expect(rendered).toContain("your own tool list names and describes each one");
    // The stub briefing carries no prose, so the whole render is the dynamic lines here.
    for (const name of TOOL_NAMES) expect(rendered).not.toContain(name);
  });

  it("does not grow when the exposed surface grows — 200 tools, same line", () => {
    // The overflow this replaced: at 29 names the render sat 34 B under the ceiling, and
    // `boundedReviewLines` drops from the END, so two more `AGENT_EXPOSED` rows deleted this
    // whole line and left the thread told nothing about its tools. A count cannot overflow.
    const render = (count: number): string =>
      renderSessionBriefing({
        briefing: fixedBriefing,
        patchset: {
          kind: "branch",
          reviewId: "rev-1",
          branch: "feat/session-thread-briefing",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
          diffCommand: `git diff ${"a".repeat(40)}...${"b".repeat(40)}`,
        },
        contextDir: ".rennet/context/a1b2c3d4-5e6f-4071-8293-a4b5c6d7e8f9",
        tools: { count, serverName: "rennet_app" },
      });
    const small = render(29);
    const huge = render(200);
    expect(bytes(huge)).toBeLessThanOrEqual(SESSION_BRIEFING_MAX_BYTES);
    // One byte apart: "29" against "200". Nothing else moved.
    expect(bytes(huge) - bytes(small)).toBe(1);
    expect(huge).toContain("200 `app_*` tools");
    expect(huge).not.toContain("more review lines omitted");
    // The shipped fixed text still arrives whole at 200 tools.
    expect(huge.startsWith(fixedBriefing.trimEnd())).toBe(true);
  });

  it("says so when no tools are attached", () => {
    // An honest empty rather than a dangling "Rennet tools on this thread:" — the thread
    // can still read the checkout, and the line it reads must match what it holds.
    const rendered = renderSessionBriefing({
      briefing: "# Stub briefing",
      patchset: {
        kind: "branch",
        reviewId: "rev-1",
        branch: "main",
        baseOid: "aaa1111",
        headOid: "bbb2222",
        diffCommand: "git diff aaa1111...bbb2222",
      },
      tools: { count: 0, serverName: "rennet_app" },
    });
    expect(rendered).toContain("- Rennet tools on this thread: none attached.");
    // ...and with no listener at all, which is what a thread whose app server could not
    // bind actually holds.
    expect(
      renderSessionBriefing({
        briefing: "# Stub briefing",
        patchset: {
          kind: "branch",
          reviewId: "rev-1",
          branch: "main",
          baseOid: "aaa1111",
          headOid: "bbb2222",
          diffCommand: "git diff aaa1111...bbb2222",
        },
      }),
    ).toContain("- Rennet tools on this thread: none attached.");
  });
});

describe("capBytes under a budget smaller than its marker", () => {
  it("returns nothing rather than a marker over budget", () => {
    for (const budget of [0, 1, 2]) {
      expect(capBytes("x".repeat(200), budget)).toBe("");
      expect(bytes(boundedReviewLines(["x".repeat(200)], budget))).toBeLessThanOrEqual(budget);
    }
    // Positive control: at exactly the marker's size the marker fits and is all that is kept.
    expect(capBytes("x".repeat(200), 3)).toBe("…");
  });
});
