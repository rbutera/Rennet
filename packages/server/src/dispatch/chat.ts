import { basename } from "node:path";
import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

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
      });
      return parseCommandOutput(name, {
        ...session,
        threadId: binding.threadId,
        threadUrl: `${session.origin}/${session.environmentId}/${binding.threadId}`,
      });
    },
  } satisfies Record<string, CommandHandler>;
}
