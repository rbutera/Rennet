import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionContextRelativeDir } from "@rennet/core";
import {
  renderSessionBriefing,
  SESSION_BRIEFING_FILE,
  SESSION_BRIEFING_MAX_BYTES,
} from "@rennet/prompts";
import type { PatchFile, Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { appToolNames, buildAppTools } from "../agent-tools";
import type { ModelSelection } from "../t3/client";
import type { T3SidecarSupervisor } from "../t3/supervisor";
import { bindReviewThread } from "./chat";
import { createDispatchRuntime, type DispatchDeps } from "./runtime";

// ─────────────────────────────────────────────────────────────────────────────
// session-thread-briefing 4.2 — WHAT PRODUCTION HANDS `createThread` FOR A SESSION.
//
// `threads.test.ts` proves the seam forwards what it is given. This proves what
// `bindReviewThread` — the ONE place a session thread is ever created — actually gives it:
// the rendered briefing, the `rennet_app` server addressed at THIS thread's id, and the
// council's selection. It drives the real function over a stub supervisor, because the
// defect it guards is an assembly that silently passes nothing (which is exactly what this
// bind did before: `createThread({ projectId, title, modelSelection, worktreePath })`).
//
// The briefing's own renderer is proven in `@rennet/prompts` (`session-briefing.test.ts`):
// deterministic over equal inputs, bounded, no board and no hunk. What that package cannot
// prove is that PRODUCTION hands it equal inputs for a big change and a small one — that is
// the byte-identity test below, and it is the reason this file exists in `server`.
//
// WHAT THIS CANNOT CATCH: that the vendored adapter appends the instructions to the real
// system prompt (cluster 1's adapter tests own that, with their own positive control), and
// that a live thread can actually reach the url — the app server's own suite drives the
// wire.
// ─────────────────────────────────────────────────────────────────────────────

const REPOSITORY_ROOT = "/repos/acme/checkout";
const SELECTION = { instanceId: "codex", model: "gpt-5.6-terra" } as unknown as ModelSelection;

function file(index: number): PatchFile {
  return {
    path: `packages/server/src/file-${index}.ts`,
    status: "modified",
    additions: 12,
    deletions: 3,
    binary: false,
    patch: `@@ -1,3 +1,12 @@\n+const change${index} = true;\n`,
  };
}

function review(fileCount: number, overrides: Partial<Review> = {}): Review {
  return {
    id: "rev-1",
    repositoryRoot: REPOSITORY_ROOT,
    activePatchsetId: "ps-1",
    dispositions: [],
    status: "current",
    patchsets: [
      {
        id: "ps-1",
        createdAt: "2026-09-12T00:00:00.000Z",
        repository: {
          id: "repo-1",
          root: REPOSITORY_ROOT,
          commonDir: `${REPOSITORY_ROOT}/.git`,
          baseRef: "main",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
          headRef: "feat/session-thread-briefing",
        },
        files: Array.from({ length: fileCount }, (_, index) => file(index)),
        rawDiff: Array.from({ length: fileCount }, (_, index) => file(index).patch).join("\n"),
        byteLength: fileCount * 64,
        truncated: false,
      },
    ],
    ...overrides,
  };
}

interface Captured {
  readonly threadId?: string;
  readonly instructions?: string;
  readonly mcpServers?: Readonly<
    Record<string, { readonly url: string; readonly bearerTokenEnvVar?: string }>
  >;
  readonly modelSelection?: ModelSelection;
  readonly key: { readonly kind: string };
}

function fixture(
  options: {
    readonly review?: Review;
    readonly sessionThread?: DispatchDeps["sessionThread"] | null;
    readonly boundRoot?: string;
  } = {},
) {
  const captured: Captured[] = [];
  const warnings: string[] = [];
  const captured$ = options.review ?? review(1);
  const t3Sidecar = {
    start: () => undefined,
    threadFor: async (input: Captured) => {
      captured.push(input);
      return {
        kind: "session" as const,
        repositoryRoot: REPOSITORY_ROOT,
        sessionId: "rev-1",
        projectId: "proj-1",
        threadId: input.threadId ?? "thread-1",
        createdAt: "2026-09-12T00:00:00.000Z",
      };
    },
  } as unknown as T3SidecarSupervisor;
  const sessionThread: DispatchDeps["sessionThread"] = {
    briefingText: () => "# You are this review's conversation\n\nEverything the reviewer can.",
    appServerFor: async (threadId) => ({
      name: "rennet_app",
      url: `http://127.0.0.1:4311/threads/${threadId}`,
      bearerTokenEnvVar: "RENNET_APP_BEARER",
    }),
    modelSelection: async () => SELECTION,
  };
  const rt = createDispatchRuntime({
    service: { reviewById: (id: string) => (id === captured$.id ? captured$ : undefined) },
    allowedRoots: new Set<string>([REPOSITORY_ROOT]),
    t3Sidecar,
    warn: (message: string) => warnings.push(message),
    ...(options.boundRoot === undefined
      ? {}
      : { boundWorkspaceForReview: async () => ({ root: options.boundRoot as string }) }),
    ...(options.sessionThread === null
      ? {}
      : { sessionThread: options.sessionThread ?? sessionThread }),
  } as unknown as DispatchDeps);
  return { captured, warnings, rt };
}

describe("bindReviewThread creates the session thread briefed and tooled", () => {
  it("passes the briefing, the app server at THIS thread's id, and the council's selection", async () => {
    const f = fixture();
    const binding = await bindReviewThread(f.rt, "rev-1");
    const create = f.captured[0];
    expect(create?.key.kind).toBe("session");
    // 1. THE BRIEFING. Its fixed half, then the review's own lines — the patchset identity
    //    and the exact diff command the core derived for this capture.
    expect(create?.instructions).toContain("You are this review's conversation");
    expect(create?.instructions).toContain("## This review");
    expect(create?.instructions).toContain("feat/session-thread-briefing");
    expect(create?.instructions).toContain(`git diff ${"a".repeat(40)}...${"b".repeat(40)}`);
    expect(Buffer.byteLength(create?.instructions ?? "", "utf8")).toBeLessThanOrEqual(
      SESSION_BRIEFING_MAX_BYTES,
    );
    // 2. THE TOOLS, at the id the thread was actually created with — the url names the
    //    thread in its path, so an address minted for a different id reaches another
    //    conversation's session stamp.
    expect(create?.mcpServers).toEqual({
      rennet_app: {
        url: `http://127.0.0.1:4311/threads/${binding.threadId}`,
        bearerTokenEnvVar: "RENNET_APP_BEARER",
      },
    });
    expect(create?.threadId).toBe(binding.threadId);
    // 3. THE COUNCIL'S ROUTING. Absent before this change, so every review's conversation
    //    ran on the sidecar's default whatever the reviewer had chosen.
    expect(create?.modelSelection).toBe(SELECTION);
    // And the briefing names the tools it was actually handed.
    expect(create?.instructions).toContain("app_board_read");
  });

  it("names the session's context directory, relative to the thread's cwd, only when one exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-briefing-ctx-"));
    try {
      const before = fixture({ boundRoot: root });
      await bindReviewThread(before.rt, "rev-1");
      // Nothing written yet — a chat-only session — so the sentence is absent rather than
      // pointing at a directory the thread would open and find missing.
      expect(before.captured[0]?.instructions).not.toContain("context directory");

      mkdirSync(join(root, sessionContextRelativeDir("rev-1")), { recursive: true });
      const after = fixture({ boundRoot: root });
      await bindReviewThread(after.rt, "rev-1");
      // RELATIVE (review finding 4): the thread's cwd is this root, and a WSL-locus review
      // runs its turns inside the distro, where the daemon's absolute path names nothing.
      expect(after.captured[0]?.instructions).toContain(
        `\`${sessionContextRelativeDir("rev-1")}/\``,
      );
      expect(after.captured[0]?.instructions).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls to the sidecar's default and SAYS SO when no installed provider answers the job", async () => {
    const f = fixture({
      sessionThread: {
        briefingText: () => "# briefing",
        appServerFor: async (threadId) => ({
          name: "rennet_app",
          url: `http://127.0.0.1:4311/threads/${threadId}`,
          bearerTokenEnvVar: "RENNET_APP_BEARER",
        }),
        modelSelection: async () => undefined,
      },
    });
    await bindReviewThread(f.rt, "rev-1");
    // No selection at all — `threadFor` then applies `DEFAULT_MODEL`, and the thread opens.
    expect(f.captured[0]?.modelSelection).toBeUndefined();
    expect(f.captured[0]?.instructions).toBeDefined();
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain("orchestrator-chat");
    expect(f.warnings[0]).toContain("rev-1");
  });

  it("still opens the thread, with an honest empty tool line, when the app listener is down", async () => {
    const f = fixture({
      sessionThread: {
        briefingText: () => "# briefing",
        appServerFor: async () => {
          throw new Error("EADDRINUSE 127.0.0.1:4311");
        },
        modelSelection: async () => SELECTION,
      },
    });
    await bindReviewThread(f.rt, "rev-1");
    expect(f.captured[0]?.mcpServers).toBeUndefined();
    expect(f.captured[0]?.instructions).toContain("none attached");
    expect(f.warnings.join("\n")).toContain("EADDRINUSE");
  });

  it("creates the thread bare when no briefing was composed, exactly as before the change", async () => {
    const f = fixture({ sessionThread: null });
    await bindReviewThread(f.rt, "rev-1");
    expect(f.captured[0]?.instructions).toBeUndefined();
    expect(f.captured[0]?.mcpServers).toBeUndefined();
    expect(f.captured[0]?.modelSelection).toBeUndefined();
  });
});

// The rule the briefing exists to keep: an append is a PREFIX, re-read on every round trip
// of every turn for the life of the thread, so it must not grow with the change. The prompts
// package proves the renderer is deterministic over equal inputs; only here can we prove
// that production's own mapping from a Review gives it equal inputs.
describe("the briefing does not grow with the change", () => {
  it("renders byte-identical for a 1-file and a 95-file review, apart from nothing at all", async () => {
    const small = fixture({ review: review(1) });
    const large = fixture({ review: review(95) });
    await bindReviewThread(small.rt, "rev-1");
    await bindReviewThread(large.rt, "rev-1");
    const a = small.captured[0]?.instructions ?? "";
    const b = large.captured[0]?.instructions ?? "";
    // Identical outright: the two reviews share an identity line (same oids, same branch),
    // and NOTHING derived from the files travels. A count, a path list or one hunk here and
    // these diverge — which is the positive control below.
    expect(b).toBe(a);
    expect(Buffer.byteLength(b, "utf8")).toBe(Buffer.byteLength(a, "utf8"));
  });

  it("differs ONLY on the identity line when the patchset identity differs", async () => {
    // The control for the test above: it can fail. A different branch and head DO change
    // the briefing, and they change one line of it.
    const base = fixture({ review: review(1) });
    const other = fixture({
      review: (() => {
        const r = review(1);
        const ps = r.patchsets[0];
        if (ps === undefined) throw new Error("fixture has no patchset");
        return {
          ...r,
          patchsets: [
            { ...ps, repository: { ...ps.repository, headRef: "other", headOid: "c".repeat(40) } },
          ],
        };
      })(),
    });
    await bindReviewThread(base.rt, "rev-1");
    await bindReviewThread(other.rt, "rev-1");
    const a = (base.captured[0]?.instructions ?? "").split("\n");
    const b = (other.captured[0]?.instructions ?? "").split("\n");
    expect(a).toHaveLength(b.length);
    const differing = a.filter((line, index) => line !== b[index]);
    expect(differing).toHaveLength(1);
    expect(differing[0]).toContain("Patchset:");
  });
});

// The briefing NAMES tools by hand in its fixed prose (`app_board_read`, `app_ask_stage`, …).
// Prose cannot be projected from the registry, so it is the one place the tool surface can
// drift: a row that leaves `AGENT_EXPOSED` leaves `buildAppTools` and the server's
// `tools/list` together, and leaves the briefing's prose only if someone remembers.
describe("every tool the briefing names is a tool the app server serves", () => {
  it("matches every `app_*` name in the shipped briefing against buildAppTools", () => {
    // The REAL shipped file, resolved the way `rounds-smoke.test.ts` resolves the prompts
    // src dir — a copy of the prose here would be a copy of the thing under test.
    const promptsSrcDir = join(dirname(fileURLToPath(import.meta.url)), "../../../prompts/src");
    const text = readFileSync(join(promptsSrcDir, SESSION_BRIEFING_FILE), "utf8");
    // `[A-Za-z_]`, not `[a-z_]`: command ids carry camelCase (`patchset.readSpan` →
    // `app_patchset_readSpan`), and a lower-case-only class would silently truncate the
    // name to `app_patchset_read` and then "fail" on a tool nobody wrote.
    const named = [...new Set(text.match(/app_[A-Za-z_]+/g) ?? [])];
    expect(named.length).toBeGreaterThan(3);
    const served = new Set(buildAppTools(async () => undefined).map((tool) => tool.name));
    expect(named.filter((name) => !served.has(name))).toEqual([]);
  });
});

// The ceiling is not a theory: the SHIPPED briefing, the REAL exposed command set and a
// realistic review have to fit under it TOGETHER, and only production knows all three at
// once. Measured at the merge of cluster 4: 4,056 B of 4,096 — 2,789 B of fixed prose, 29
// tool names, and the review's three lines. That is thin, deliberately so (an append is a
// prefix re-read on every round trip of every turn for the thread's life), and the line it
// costs first is the tool list, which `boundedReviewLines` drops from the end with an
// honest marker. Flipping a few more rows into `AGENT_EXPOSED` is what would spend the
// remaining bytes, so the assertion is on the LINE surviving, not only on the total.
describe("the real briefing fits, with its tool line intact", () => {
  it("renders the shipped file and the live tool set under the ceiling", () => {
    const promptsSrcDir = join(dirname(fileURLToPath(import.meta.url)), "../../../prompts/src");
    const fixed = readFileSync(join(promptsSrcDir, SESSION_BRIEFING_FILE), "utf8");
    const rendered = renderSessionBriefing({
      briefing: fixed,
      patchset: {
        kind: "branch",
        branch: "feat/session-thread-briefing-c4",
        baseOid: "a".repeat(40),
        headOid: "b".repeat(40),
        diffCommand: `git diff ${"a".repeat(40)}...${"b".repeat(40)}`,
      },
      // A real session context directory path: a uuid under `.rennet/context/`.
      contextDir: ".rennet/context/a1b2c3d4-5e6f-4071-8293-a4b5c6d7e8f9",
      toolNames: appToolNames(),
    });
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(SESSION_BRIEFING_MAX_BYTES);
    // Not merely under the ceiling — still SAYING the three things it is for. A render that
    // spent its budget would carry the omission marker instead of one of these.
    expect(rendered).toContain("Patchset:");
    expect(rendered).toContain("context directory");
    expect(rendered).toContain("Rennet tools on this thread:");
    expect(rendered).not.toContain("more review lines omitted");
    // ...and the fixed prose survives WHOLE. `capBytes` is the renderer's last resort and it
    // ends the text with a bare "…", which would eat the closing register guidance silently.
    expect(rendered.startsWith(fixed.trimEnd())).toBe(true);
  });
});
