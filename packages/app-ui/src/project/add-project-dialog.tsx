import type { ProjectSource } from "@rennet/protocol";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
} from "@rennet/ui";
import { Check, ChevronDown, Monitor, Plus, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { DirectoryBrowser } from "../components/directory-browser";
import { Icon } from "../components/icon";
import { useBridge, useCommand, useMutation } from "../data";
import { messageFrom } from "../lib/message-from";
import { projectIndexingPath } from "../routes/url";
import { selectDialogOpen, useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Add Project dialog (C12 §10.1). The dialog C3's sidebar opens via
// `ui.openDialog("add-project")`: a source picker + the inline directory browser
// (the REUSED `components/directory-browser.tsx`, not the spike's port). No
// detected-dirs list, no recents — the browser IS the picker. Add is inert until a
// folder is selected; the dialog reopens clean each time (the body remounts on
// open). Adding runs `project.discover` (+ `projects.add`) through the seam,
// produces no orchestrator turn, and navigates straight to the indexing view.
// ─────────────────────────────────────────────────────────────────────────────

/** One browsable environment (source) the picker lists: local, or a paired remote. */
interface Environment {
  readonly source: ProjectSource;
  readonly label: string;
  readonly kind: "local" | "remote";
}

/** Every environment the picker offers: Local always first, then each paired remote.
 *  Paired devices come through the seam (`pairing.listDevices`); an unavailable handler
 *  (or none paired) simply leaves Local — the one environment always present. */
function useEnvironments(): Environment[] {
  const { data } = useCommand("pairing.listDevices", {});
  const remotes: Environment[] = (data?.devices ?? []).map((device) => ({
    source: `remote:${device.deviceId}` as ProjectSource,
    label: device.name,
    kind: "remote",
  }));
  // ponytail: WSL distros are enumerated by the desktop shell (no protocol command),
  // so they extend this list only once the shell injects them — Local + paired remotes
  // is the whole set reachable through the seam. Add shell-fed distros when wired.
  return [{ source: "local", label: "This machine", kind: "local" }, ...remotes];
}

export function AddProjectDialog() {
  const open = useRennetStore(selectDialogOpen("add-project"));
  const closeDialog = useRennetStore((s) => s.uiActions.closeDialog);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeDialog("add-project");
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg md:max-w-xl">
        {/* Gated on `open` so the body REMOUNTS each time — a clean state every reopen. */}
        {open ? <AddProjectBody onClose={() => closeDialog("add-project")} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddProjectBody({ onClose }: { onClose(): void }) {
  const bridge = useBridge();
  const [, navigate] = useLocation();
  const openDialog = useRennetStore((s) => s.uiActions.openDialog);
  const environments = useEnvironments();

  const pendingSource = useRennetStore((s) => s.ui.pendingAddProjectSource);
  const clearAddProjectSource = useRennetStore((s) => s.uiActions.clearAddProjectSource);

  const [source, setSource] = useState<ProjectSource>(
    (pendingSource as ProjectSource | undefined) ?? "local",
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Consume the one-shot preselection from Add Environment → Browse Its Projects. On a
  // fresh mount `source` already initialised to it above; this also switches an
  // already-open dialog and, either way, clears the pending hop so the NEXT reopen is clean.
  useEffect(() => {
    if (!pendingSource) return;
    setSource(pendingSource as ProjectSource);
    setSelectedPath(null);
    clearAddProjectSource();
  }, [pendingSource, clearAddProjectSource]);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const choose = useMutation("repository.choose");
  const discover = useMutation("project.discover");
  const addProject = useMutation("projects.add", { invalidates: ["projects.list"] });

  const current =
    environments.find((environment) => environment.source === source) ?? environments[0];

  function selectSource(next: ProjectSource): void {
    setSourceOpen(false);
    if (next === source) return;
    // Switching source clears the selected path and reloads the browser against that
    // host (the `reloadKey` below is the source, so the browser remounts its listing).
    setSource(next);
    setSelectedPath(null);
    setError(undefined);
  }

  async function add(): Promise<void> {
    if (!selectedPath || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // Grant the browsed path on the source's daemon before discovering it (the daemon
      // only scans granted paths). The user browsed here; forwarding the grant is not a gate.
      await choose.mutate({ path: selectedPath });
      // No kind picker (§10.1): try the path AS a repo; if it is not one, treat it as a
      // workspace and scan its children. ponytail: two reads only on the fallback, and the
      // browser gives no current-dir repo signal to decide it in one.
      let { discovery } = await discover.mutate({
        commandId: crypto.randomUUID(),
        path: selectedPath,
        kind: "repo",
        source,
      });
      if (discovery.repos.length === 0) {
        ({ discovery } = await discover.mutate({
          commandId: crypto.randomUUID(),
          path: selectedPath,
          kind: "workspace",
          source,
        }));
      }
      const { project } = await addProject.mutate({
        commandId: crypto.randomUUID(),
        discovery,
        includedRepos: discovery.repos.map((repo) => repo.name),
        primaryBranch: discovery.primaryBranch,
      });
      // Persisted with no orchestrator turn; the sidebar (projects.list, invalidated above)
      // carries it. Straight to the indexing view — scout + map generation live there.
      onClose();
      navigate(projectIndexingPath(project.id));
    } catch (reason) {
      setError(messageFrom(reason));
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add project</DialogTitle>
        <DialogDescription>Pick a source and a folder of repositories.</DialogDescription>
      </DialogHeader>

      <Popover open={sourceOpen} onOpenChange={setSourceOpen}>
        <PopoverTrigger
          aria-label={`Source: ${current?.label ?? "none"}`}
          render={<Button variant="outline" className="w-full justify-between" />}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon
              icon={current?.kind === "local" ? Monitor : Server}
              className="size-4 flex-none text-ink-faint"
            />
            <span className="truncate">{current?.label}</span>
          </span>
          <Icon icon={ChevronDown} className="size-4 flex-none text-ink-faint" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--anchor-width) min-w-56 gap-0 p-1">
          {environments.map((environment) => (
            <button
              key={environment.source}
              type="button"
              className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-base text-ink hover:bg-raised sm:py-1.5"
              onClick={() => selectSource(environment.source)}
            >
              <Icon
                icon={environment.kind === "local" ? Monitor : Server}
                className="size-4 flex-none text-ink-faint"
              />
              <span className="flex-1 truncate">{environment.label}</span>
              {environment.source === current?.source ? (
                <Icon icon={Check} className="size-4 flex-none text-accent" />
              ) : null}
            </button>
          ))}
          <Separator className="my-1" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-base text-ink hover:bg-raised sm:py-1.5"
            onClick={() => {
              setSourceOpen(false);
              openDialog("add-environment");
            }}
          >
            <Icon icon={Plus} className="size-4 flex-none text-ink-faint" />
            Add Environment
          </button>
        </PopoverContent>
      </Popover>

      <DirectoryBrowser
        bridge={bridge}
        reloadKey={source}
        onPathChange={setSelectedPath}
        onPathInvalid={() => setSelectedPath(null)}
      />

      {error ? (
        <p
          className="add-project-error px-3.5 py-2 rounded-chip border border-danger bg-danger-soft text-ink text-sm"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void add()} disabled={!selectedPath || busy}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </DialogFooter>
    </>
  );
}
