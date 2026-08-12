import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalize } from "@rennet/protocol";
import type { RepoComposition, WorkspaceContext } from "@rennet/types";
import type { ProjectSnapshotStore } from "./project-snapshot-store";

export class RepoCompositionStore {
  private sequence = 0;

  constructor(
    private readonly snapshots: ProjectSnapshotStore,
    private readonly workspacesDir = join(homedir(), ".rennet", "workspaces"),
  ) {}

  repoPath(repoKey: string): string {
    return join(this.snapshots.paths(repoKey).projectDir, "composition.json");
  }

  workspacePath(workspaceId: string): string {
    return join(this.workspacesDir, workspaceId, "context.json");
  }

  saveRepo(composition: RepoComposition): void {
    this.writeAtomic(this.repoPath(composition.repoRecordId), composition);
  }

  loadRepo(repoKey: string): RepoComposition | null {
    return this.read(this.repoPath(repoKey)) as RepoComposition | null;
  }

  saveWorkspace(context: WorkspaceContext): void {
    this.writeAtomic(this.workspacePath(context.workspaceId), context);
  }

  loadWorkspace(workspaceId: string): WorkspaceContext | null {
    return this.read(this.workspacePath(workspaceId)) as WorkspaceContext | null;
  }

  private read(path: string): unknown | null {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }

  private writeAtomic(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${this.sequence++}`;
    writeFileSync(temporary, `${canonicalize(value)}\n`, "utf8");
    renameSync(temporary, path);
  }
}
