import { basename } from "node:path";
import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

/**
 * The session's bound workspace as `threadFor` takes it (session-bound-workspace 5.2). The
 * review's own thread — the one chat and the handoff share — runs in the workspace the session
 * is bound to, not the repository root, so a PR snapshot's chat reads the reviewed head and a
 * branch review's chat reads the branch. A host with no resolver wired answers nothing and the
 * thread falls back to the project root, exactly as before the binding existed.
 */
function boundWorkspaceInput(
  rt: DispatchRuntime,
  reviewId: string,
): { worktreePath?: string; branch?: string } {
  const bound = rt.deps.boundWorkspaceForReview?.(reviewId);
  if (bound === undefined) return {};
  return {
    worktreePath: bound.root,
    ...(bound.branch === undefined ? {} : { branch: bound.branch }),
  };
}

export function chatHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "chat.t3Session": async (rawInput) => {
      const name = "chat.t3Session" as const;
      // Broker sidecar access to a client (t3code-sidecar-chat, 2.4): the daemon owns the
      // credential, the client never reads the token file. Starting the sidecar on first
      // ask is the whole point — no gate, no confirmation (Rule Zero). Absent supervisor ⇒
      // this daemon was composed without a vendored bundle; say so.
      const input = parseCommandInput(name, rawInput);
      if (!deps.t3Sidecar) {
        throw new Error("chat.t3Session: this daemon has no T3 Code sidecar composed");
      }
      const session = await deps.t3Sidecar.session();
      if (input.reviewId === undefined) return parseCommandOutput(name, session);
      // With a review: bind its thread, keyed on the review's REPOSITORY ROOT and the review
      // id — never the project — so two repos on one branch get two threads (3.2). The
      // review lookup throws for an unknown id, like every review read.
      const review = rt.requireReviewById(input.reviewId);
      const binding = await deps.t3Sidecar.threadFor({
        repositoryRoot: review.repositoryRoot,
        key: { kind: "session", sessionId: input.reviewId },
        title: basename(review.repositoryRoot) || "review",
        ...boundWorkspaceInput(rt, input.reviewId),
      });
      return parseCommandOutput(name, {
        ...session,
        threadId: binding.threadId,
        threadUrl: `${session.origin}/${session.environmentId}/${binding.threadId}`,
      });
    },
    // chat.t3Send (t3-lens-threads 4.2): start a turn on the review's bound thread with the
    // client's text. The anchored ask's path — it replaces `review.ask`, whose orchestrator
    // session is retired. Same binding rule as `chat.t3Session`: keyed on the review's
    // REPOSITORY ROOT, so two repos on one branch never share a thread.
    "chat.t3Send": async (rawInput) => {
      const name = "chat.t3Send" as const;
      const input = parseCommandInput(name, rawInput);
      if (!deps.t3Sidecar) {
        throw new Error("chat.t3Send: this daemon has no T3 Code sidecar composed");
      }
      const review = rt.requireReviewById(input.reviewId);
      const binding = await deps.t3Sidecar.threadFor({
        repositoryRoot: review.repositoryRoot,
        key: { kind: "session", sessionId: input.reviewId },
        title: basename(review.repositoryRoot) || "review",
        ...boundWorkspaceInput(rt, input.reviewId),
      });
      const client = await deps.t3Sidecar.client();
      await client.startTurn({ threadId: binding.threadId, text: input.text });
      return parseCommandOutput(name, { threadId: binding.threadId });
    },
  } satisfies Record<string, CommandHandler>;
}
