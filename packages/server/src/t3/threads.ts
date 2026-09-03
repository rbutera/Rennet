// Session-to-thread binding (t3code-sidecar-chat, 3.2). A Rennet session gets exactly one
// T3 thread, keyed on the REPOSITORY ROOT and the session id, never on `Project.id` or
// `openPath`: a workspace maps many repos to one project, and two repos on the same
// branch must resolve to two threads rooted in two checkouts. The T3 project the thread
// hangs off is the one whose `workspaceRoot` is that checkout, created on first use.
//
// Persisted as one JSON file under the sidecar's private base dir, so the binding survives
// a daemon restart and stays beside the state it points into.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { ModelSelection, T3Client } from "./client";
import { sidecarBaseDir } from "./sidecar";

const bindingSchema = z.object({
  repositoryRoot: z.string(),
  sessionId: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  createdAt: z.string(),
});
export type ThreadBinding = z.infer<typeof bindingSchema>;

const fileSchema = z.object({ bindings: z.array(bindingSchema) });

export function bindingsPath(dataDir: string): string {
  return join(sidecarBaseDir(dataDir), "thread-bindings.json");
}

export function readBindings(dataDir: string): ThreadBinding[] {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(bindingsPath(dataDir), "utf8")));
    return parsed.success ? parsed.data.bindings : [];
  } catch {
    return [];
  }
}

function writeBindings(dataDir: string, bindings: ThreadBinding[]): void {
  const path = bindingsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ bindings })}\n`);
  renameSync(tmp, path);
}

export function findBinding(
  dataDir: string,
  repositoryRoot: string,
  sessionId: string,
): ThreadBinding | undefined {
  return readBindings(dataDir).find(
    (b) => b.repositoryRoot === repositoryRoot && b.sessionId === sessionId,
  );
}

export interface BindThreadInput {
  readonly dataDir: string;
  readonly client: T3Client;
  /** The checkout the session names; the thread's cwd. */
  readonly repositoryRoot: string;
  readonly sessionId: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
}

/**
 * The thread bound to this session on this repository, created on first use with the
 * checkout as its working directory in full-access mode. Idempotent per key.
 */
export async function bindThread(input: BindThreadInput): Promise<ThreadBinding> {
  const existing = findBinding(input.dataDir, input.repositoryRoot, input.sessionId);
  if (existing) return existing;
  const projectId = await input.client.ensureProject(
    input.repositoryRoot,
    basename(input.repositoryRoot),
  );
  const threadId = await input.client.createThread({
    projectId,
    title: input.title,
    modelSelection: input.modelSelection,
  });
  const binding: ThreadBinding = {
    repositoryRoot: input.repositoryRoot,
    sessionId: input.sessionId,
    projectId,
    threadId,
    createdAt: new Date().toISOString(),
  };
  // Re-read before writing: another bind for a different key may have landed meanwhile.
  writeBindings(input.dataDir, [...readBindings(input.dataDir), binding]);
  return binding;
}
