import type { CreateThreadInput, ModelSelection } from "./client";

// ─────────────────────────────────────────────────────────────────────────────
// The `thread.create` command's FIELDS, built without the vendored bundle.
//
// `client.ts` cannot be imported without the vendored `@t3tools/*` runtime, so its own
// suite is bundle-gated and skips wherever the bundle is not built — which is most
// developer machines and the fast branch gate. That is exactly where this one field lives
// that nothing else can check: the session bind MINTS the thread id, embeds it in the
// `rennet_app` url's path, and hands both to one create. If `createThread` mints its own id
// instead of using the caller's, the thread is created holding an address that points at a
// DIFFERENT conversation — the tool calls land with another thread's session stamp — and
// every one of the bind tests stays green, because they assert against the stub client they
// were handed rather than against the real command.
//
// So the field assembly is here, pure and importable with no bundle, and `client.ts` calls
// it and applies the schema brands to what it returns. This is the only module that decides
// what a `thread.create` carries.
// ─────────────────────────────────────────────────────────────────────────────

/** T3's full-access runtime mode — the posture Rule Zero mandates for a Rennet thread. */
export const FULL_ACCESS_RUNTIME_MODE = "full-access";

/** The `thread.create` payload, before the branded-id casts `client.ts` applies. */
export interface ThreadCreateFields {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: string;
  readonly interactionMode: "default";
  /** `null`, never absent: T3 reads an absent branch as "no branch", which is the same thing. */
  readonly branch: string | null;
  /** `null` ⇒ the project root, which is correct only when the two are the same tree. */
  readonly worktreePath: string | null;
  readonly instructions?: string;
  readonly mcpServers?: Readonly<
    Record<string, { readonly url: string; readonly bearerTokenEnvVar?: string }>
  >;
}

/**
 * Build the `thread.create` fields for one create.
 *
 * `mintId` is only reached when the CALLER named no id. T3 mints thread ids client-side —
 * the id rides the create command rather than coming back in its reply — so a caller that
 * has to know the id first is allowed to name it, and the session bind is exactly that
 * caller: the app-tools url carries the thread id in its path and has to be on the same
 * command.
 */
export function threadCreateFields(
  input: CreateThreadInput,
  mintId: () => string,
): ThreadCreateFields {
  return {
    threadId: input.threadId ?? mintId(),
    projectId: input.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode ?? FULL_ACCESS_RUNTIME_MODE,
    interactionMode: "default",
    // The session's bound workspace: T3 resolves cwd as `worktreePath ?? project.workspaceRoot`,
    // so an absent binding still means the project root, exactly as before.
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
  };
}
