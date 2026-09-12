import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { reviewedDiffCommand, sessionContextRelativeDir } from "@rennet/core";
import { renderSessionBriefing, type SessionBriefingPatchset } from "@rennet/prompts";
import { parseCommandInput, parseCommandOutput, type Review } from "@rennet/protocol";
import { appToolNames } from "../agent-tools";
import { sessionContextDir } from "../context-files";
import type { SessionThreadCreation, ThreadBinding } from "../t3/threads";
import type { CommandHandler, DispatchRuntime } from "./runtime";

/**
 * The session's bound workspace as `threadFor` takes it (session-bound-workspace 5.2). The
 * review's own thread — the one chat and the handoff share — runs in the workspace the session
 * is bound to, not the repository root, so a PR snapshot's chat reads the reviewed head and a
 * branch review's chat reads the branch. A host with no resolver wired answers nothing and the
 * thread falls back to the project root, exactly as before the binding existed.
 */
async function boundWorkspaceInput(
  rt: DispatchRuntime,
  reviewId: string,
): Promise<{ worktreePath?: string; branch?: string }> {
  const bound = await rt.deps.boundWorkspaceForReview?.(reviewId);
  if (bound === undefined) return {};
  return {
    worktreePath: bound.root,
    ...(bound.branch === undefined ? {} : { branch: bound.branch }),
  };
}

/**
 * The review's own T3 thread — the ONE the chat dock, `chat.t3Send` and the handoff share.
 *
 * Every caller goes through here, and that is the point: the binding key root is the bound
 * WORKSPACE when the session has one and the repository otherwise (`keyRootOf` in
 * ../t3/threads), so a caller that assembled the input differently would key a SECOND
 * thread for the same review and split the transcript between them. `review.capture` now
 * binds this ahead of the dock (#849), which is exactly the situation that makes one
 * assembly point load-bearing rather than tidy.
 *
 * Keyed on the review's REPOSITORY ROOT and the review id — never the project — so two
 * repos on one branch get two threads (t3code-sidecar-chat 3.2).
 */
export async function bindReviewThread(
  rt: DispatchRuntime,
  reviewId: string,
): Promise<ThreadBinding> {
  const sidecar = rt.deps.t3Sidecar;
  if (!sidecar) throw new Error("this daemon has no T3 Code sidecar composed");
  const review = rt.requireReviewById(reviewId);
  const workspace = await boundWorkspaceInput(rt, reviewId);
  // Minted HERE, before the create, because the app-tools url names the thread in its path
  // and both have to ride the same `thread.create` (T3 mints thread ids client-side, so
  // this is its own convention, not a workaround). Discarded unread when the binding
  // already exists: an existing thread keeps the id, the briefing and the servers it was
  // created with, for its whole life.
  const threadId = randomUUID();
  return sidecar.threadFor({
    repositoryRoot: review.repositoryRoot,
    key: { kind: "session", sessionId: reviewId },
    title: basename(review.repositoryRoot) || "review",
    threadId,
    ...workspace,
    // LAZY, and that is the point: almost every bind finds an existing row, and resolving
    // this reads a prompt file, renders the briefing, awaits the app listener and asks the
    // council what this host has installed. `bindThread` invokes it only when it is really
    // about to create a thread — so an ordinary `chat.t3Send` pays none of it, and the "no
    // installed provider" line lands in the log once per thread rather than once per send.
    creation: () => sessionThreadCreation(rt, review, threadId, workspace.worktreePath),
  });
}

/** Which capture this is, in the identity a reviewer would recognise it by. */
function briefingPatchset(rt: DispatchRuntime, review: Review): SessionBriefingPatchset {
  const patchset = rt.activePatchsetOf(review);
  const repository = patchset.repository;
  const branch = repository.headRef;
  return {
    kind: review.postTarget === undefined ? "branch" : "pr",
    ...(branch === undefined ? {} : { branch }),
    ...(review.postTarget === undefined ? {} : { prNumber: review.postTarget.number }),
    baseOid: repository.baseOid,
    headOid: repository.headOid,
    // The core's own derivation, never a second one: a working-tree capture and a range
    // capture take different commands, and the seats already read this one.
    diffCommand: reviewedDiffCommand(repository),
  };
}

/**
 * The session's context directory as the THREAD can open it, or nothing when none has been
 * written yet (a chat-only session that has never drafted a board).
 *
 * RELATIVE, for the reason every other prompt's context pointer is (create-server's
 * `writeReviewContext`, review finding 4): the thread's cwd IS this root, and a WSL-locus
 * review runs its turns inside the distro where the daemon's own absolute path names
 * nothing. The existence check runs against the daemon-side absolute path; the sentence
 * carries the relative one.
 */
function briefingContextDir(rt: DispatchRuntime, review: Review, root: string): string | undefined {
  const sessionId = rt.deps.reviewContextSessionId?.(review) ?? review.id;
  return existsSync(sessionContextDir(root, sessionId))
    ? sessionContextRelativeDir(sessionId)
    : undefined;
}

/**
 * The three things a SESSION thread is created with beyond its cwd, assembled in the one
 * place a session thread is ever created (session-thread-briefing 4.1): the briefing, the
 * app-tools server, and the council's routing.
 *
 * EVERY failure here degrades rather than costing the reviewer their thread, and the word
 * "every" is load-bearing: it is a promise about four separate things that can throw, and
 * a promise that guards two of them is worse than no promise, because the next reader
 * believes it. A listener that could not bind means no tools — and the briefing then SAYS
 * none are attached, which is true — rather than no conversation. A council with no
 * installed provider means the sidecar's default model with a line in the daemon log. A
 * review whose active patchset is missing, or a prompt file that cannot be read, means no
 * briefing, with the tools and the selection still attached. A bare thread is what every
 * session had before this change, so the worst case is the old behaviour, named.
 */
async function sessionThreadCreation(
  rt: DispatchRuntime,
  review: Review,
  threadId: string,
  worktreePath: string | undefined,
): Promise<SessionThreadCreation> {
  const seam = rt.deps.sessionThread;
  if (seam === undefined) return {};
  const warn = rt.deps.warn ?? console.warn;
  let app: Awaited<ReturnType<typeof seam.appServerFor>> | undefined;
  try {
    app = await seam.appServerFor(threadId);
  } catch (error) {
    warn(
      `rennet: review ${review.id}'s thread gets no Rennet app tools: ${describeThreadError(error)}`,
    );
  }
  const selection = await seam.modelSelection(worktreePath ?? review.repositoryRoot);
  if (selection === undefined) {
    warn(
      `rennet: no installed provider answers the council's orchestrator-chat job; review ${review.id}'s thread opens on the sidecar's default model`,
    );
  }
  const servers =
    app === undefined
      ? {}
      : {
          mcpServers: { [app.name]: { url: app.url, bearerTokenEnvVar: app.bearerTokenEnvVar } },
        };
  const model = selection === undefined ? {} : { modelSelection: selection };
  let briefing: string;
  try {
    // Both of these throw: `activePatchsetOf` refuses a review whose active id names no
    // patchset ("The active patchset is missing"), and `briefingText` is a file read off
    // the shipped prompts directory. Neither is a reason to deny the reviewer a thread.
    const patchset = briefingPatchset(rt, review);
    const fixed = await seam.briefingText();
    const contextDir = briefingContextDir(rt, review, worktreePath ?? review.repositoryRoot);
    briefing = renderSessionBriefing({
      briefing: fixed,
      patchset,
      ...(contextDir === undefined ? {} : { contextDir }),
      // HOW MANY tools the server actually serves and what it is called — never the
      // names, which the harness's own `tools/list` delivers with a description each. No
      // listener answered above ⇒ no tools, and the line says so.
      ...(app === undefined
        ? {}
        : { tools: { count: appToolNames().length, serverName: app.name } }),
    });
  } catch (error) {
    warn(`rennet: review ${review.id}'s thread gets no briefing: ${describeThreadError(error)}`);
    return { ...servers, ...model };
  }
  return { instructions: briefing, ...servers, ...model };
}

/** A thrown thing as a sentence a reviewer can read. Same shape as `t3/threads.ts`. */
export const describeThreadError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function chatHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "chat.t3Session": async (rawInput) => {
      const name = "chat.t3Session" as const;
      // Broker sidecar access to a client (t3code-sidecar-chat, 2.4): the daemon owns the
      // credential, the client never reads the token file. The sidecar is already coming up
      // — the daemon started it at launch (#849) — so this usually joins a bring-up that is
      // finished or nearly so rather than beginning one; it still starts one when it has to,
      // with no gate and no confirmation (Rule Zero). Absent supervisor ⇒ this daemon was
      // composed without a vendored bundle; say so.
      const input = parseCommandInput(name, rawInput);
      if (!deps.t3Sidecar) {
        throw new Error("chat.t3Session: this daemon has no T3 Code sidecar composed");
      }
      const session = await deps.t3Sidecar.session();
      if (input.reviewId === undefined) return parseCommandOutput(name, session);
      // With a review: its own thread, through the one assembly point. `review.capture`
      // has normally bound it already, so this reads the existing row.
      //
      // A FAILED BIND IS A REPORTED STATE, NOT A REJECTION (#872). The environment and the
      // bearer above are good whatever the bind does, and throwing here threw them away
      // too: an unknown review id, or a bound workspace that has been deleted, surfaced in
      // the dock as "T3 Code sidecar unavailable" over a perfectly healthy sidecar, and the
      // mount never rendered. The reviewer gets the session, plus the reason in the arm.
      try {
        const binding = await bindReviewThread(rt, input.reviewId);
        return parseCommandOutput(name, {
          ...session,
          thread: {
            status: "bound",
            threadId: binding.threadId,
            threadUrl: `${session.origin}/${session.environmentId}/${binding.threadId}`,
          },
        });
      } catch (error) {
        return parseCommandOutput(name, {
          ...session,
          thread: { status: "unavailable", reason: describeThreadError(error) },
        });
      }
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
      // A FAILED ASK IS A REPORTED STATE, NOT A REJECTION — the #872 ruling `chat.t3Session`
      // already follows twenty lines up, applied to the send. It threw here, so the IDENTICAL
      // condition (a deleted bound workspace, an unknown review, a sidecar that will not come
      // up) rendered calmly in the dock on the read and became an untyped rejection on the
      // send. The client had nowhere to put an untyped rejection and dropped it on the floor:
      // the dock opened, nothing streamed, and the reviewer concluded "explain no longer
      // works" (#888) while their own question sat in the quote thread looking delivered.
      //
      // The reason travels verbatim so the reviewer can tell the two apart — a sidecar that
      // is not built ("the vendored T3 Code server bundle is not built") reads nothing like a
      // daemon whose descriptors ran out ("spawn EBADF"), and only one of those is worth
      // retrying. Nothing here fabricates a reply; it reports that the question did not go.
      try {
        const binding = await bindReviewThread(rt, input.reviewId);
        const client = await deps.t3Sidecar.client();
        await client.startTurn({ threadId: binding.threadId, text: input.text });
        return parseCommandOutput(name, { status: "sent", threadId: binding.threadId });
      } catch (error) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: describeThreadError(error),
        });
      }
    },
  } satisfies Record<string, CommandHandler>;
}
