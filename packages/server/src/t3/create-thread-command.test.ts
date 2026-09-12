import { describe, expect, it } from "vitest";
import { startAppMcpServer } from "../app/app-mcp-server";
import type { CreateThreadInput, ModelSelection } from "./client";
import { FULL_ACCESS_RUNTIME_MODE, threadCreateFields } from "./create-thread-command";

// ─────────────────────────────────────────────────────────────────────────────
// session-thread-briefing — THE CALLER'S THREAD ID REACHES THE REAL COMMAND.
//
// `threads.test.ts` proves the bind forwards its minted id to `client.createThread`, and
// stops there, because `client.ts` cannot be imported without the vendored bundle and its
// own suite skips wherever that bundle is not built. That gap is load-bearing rather than
// tidy: the real client was changed to ignore `input.threadId` and mint a UUID of its own,
// and all twenty-eight bind tests stayed green. The thread would then have been created
// holding an `rennet_app` url naming a DIFFERENT thread — every tool call landing with
// another conversation's session stamp — and nothing in the suite could see it.
//
// So the field assembly lives in a module with no bundle dependency, and this drives it.
//
// WHAT THIS CANNOT CATCH: that `client.ts` dispatches these fields rather than rebuilding
// them. It spreads the return and overrides only the two branded ids, which is as close to
// "cannot" as a type gets, and `client.test.ts` drives the real wire when the bundle exists.
// ─────────────────────────────────────────────────────────────────────────────

const SELECTION = { instanceId: "claudeAgent", model: "x" } as unknown as ModelSelection;

const base = (over: Partial<CreateThreadInput> = {}): CreateThreadInput => ({
  projectId: "proj-1",
  title: "review",
  modelSelection: SELECTION,
  ...over,
});

describe("the thread.create command carries the id its caller named", () => {
  it("uses the caller's id and never mints over it", () => {
    let minted = 0;
    const fields = threadCreateFields(base({ threadId: "thread-abc" }), () => {
      minted += 1;
      return "a-fresh-uuid";
    });
    expect(fields.threadId).toBe("thread-abc");
    // Not merely equal by luck: the minter was never reached.
    expect(minted).toBe(0);
  });

  it("mints for the callers that do not name one — the seats and the rounds", () => {
    // The control for the assertion above: it CAN mint, so "uses the caller's id" is a
    // statement about the branch taken, not about a minter that never works.
    const fields = threadCreateFields(base(), () => "a-fresh-uuid");
    expect(fields.threadId).toBe("a-fresh-uuid");
  });

  it("names the same thread the rennet_app address in the same create names", async () => {
    // The whole reason the id is minted early. A live listener, because the url shape is
    // its own and a hand-written one here would be a copy of the thing under test.
    const server = await startAppMcpServer({ bearer: () => "b", dispatch: () => async () => ({}) });
    try {
      const threadId = "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
      const address = server.addressFor(threadId);
      const fields = threadCreateFields(
        base({
          threadId,
          mcpServers: {
            [address.name]: {
              url: address.url,
              bearerTokenEnvVar: address.bearerTokenEnvVar,
            },
          },
        }),
        () => "a-fresh-uuid",
      );
      const url = new URL(fields.mcpServers?.rennet_app?.url ?? "");
      // `/threads/<threadId>`: the path segment IS the thread's identity to the app server,
      // and it is what stamps `ctx.author` on every tool call the thread makes.
      expect(url.pathname).toBe(`/threads/${threadId}`);
      expect(fields.threadId).toBe(decodeURIComponent(url.pathname.split("/").pop() ?? ""));
    } finally {
      await server.close();
    }
  });

  it("keeps the rest of the command the same, including full access", () => {
    const fields = threadCreateFields(
      base({ worktreePath: "/repos/a/.rennet/wt-1", branch: "feat/x", instructions: "## brief" }),
      () => "a-fresh-uuid",
    );
    expect(fields).toMatchObject({
      projectId: "proj-1",
      title: "review",
      runtimeMode: FULL_ACCESS_RUNTIME_MODE,
      interactionMode: "default",
      branch: "feat/x",
      worktreePath: "/repos/a/.rennet/wt-1",
      instructions: "## brief",
    });
    // `null`, not absent: T3 resolves cwd as `worktreePath ?? project.workspaceRoot`.
    expect(threadCreateFields(base(), () => "u").worktreePath).toBeNull();
    expect(threadCreateFields(base(), () => "u").branch).toBeNull();
    // A thread with no briefing carries no key at all, rather than an empty one.
    expect(
      Object.hasOwn(
        threadCreateFields(base(), () => "u"),
        "instructions",
      ),
    ).toBe(false);
    expect(
      Object.hasOwn(
        threadCreateFields(base(), () => "u"),
        "mcpServers",
      ),
    ).toBe(false);
  });
});
