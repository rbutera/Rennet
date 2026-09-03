// The session context directory, from the pure side (session-context-files, design D3/D4).
//
// The WRITER is `packages/server`'s `writeSessionContext` — node-owned, one of it. What
// lives here is the two things a node-free prompt builder needs: the SHAPE of a file it
// wants written, and the RELATIVE path a prompt names it by.
//
// Relative is the whole point. A turn runs with its cwd set to the session's bound root,
// so `.rennet/context/<sessionId>/asks.json` resolves with the agent's own tools exactly
// the way the checkout does. An absolute path would work only on the daemon's own locus.

/**
 * One file a turn may read, with the two lines its `README.md` index entry needs. The
 * server's writer takes this shape structurally; `holds` and `readWhen` are written for a
 * reader who has never seen Rennet and has only the prompt and this directory.
 */
export interface SessionContextFile {
  /** Path relative to the session's context directory; may name a subdirectory. */
  readonly name: string;
  readonly body: string;
  /** One line: what this file holds. */
  readonly holds: string;
  /** One line: when a turn should read it. */
  readonly readWhen: string;
}

/**
 * The session's context directory, relative to the bound root — the form a prompt names.
 * The server's `sessionContextDir` joins this onto the root, so the two cannot drift.
 */
export function sessionContextRelativeDir(sessionId: string): string {
  return `.rennet/context/${sessionId}`;
}

/** The relative path of one context file, as a prompt names it. */
export function sessionContextPath(sessionId: string, name: string): string {
  return `${sessionContextRelativeDir(sessionId)}/${name}`;
}
