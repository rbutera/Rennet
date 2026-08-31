import type { Project, ProjectSource } from "@rennet/protocol";
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
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DirectoryBrowser } from "../components/directory-browser";
import { Icon } from "../components/icon";
import { useBridge, useMutation } from "../data";
import { messageFrom } from "../lib/message-from";
import { projectIndexingPath } from "../routes/url";
import { useConnectionCapabilities } from "../shell/connection-capabilities";
import { selectDialogOpen, useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Add Project dialog (C12 §10.1). The dialog C3's sidebar opens via
// `ui.openDialog("add-project")`: a source picker + the inline directory browser
// (the REUSED `components/directory-browser.tsx`, not the spike's port). No
// detected-dirs list, no recents — the browser IS the picker. Add is inert until a
// folder is selected; the dialog reopens clean each time (the body remounts on
// open). Adding runs `project.discover` (+ `projects.add`) through the seam,
// produces no orchestrator turn, and navigates straight to the indexing view.
//
// The source picker lists the shell's REAL browsable daemons (Local, each WSL distro,
// each paired remote) — NOT `pairing.listDevices` (those are inbound clients of THIS
// daemon, not daemons this client can browse). Switching to another daemon calls the
// shell's `connectSource`: the app remounts onto that daemon and the browser below lists
// ITS filesystem (blocker 2). Outside the shell the capabilities fall back to Local only.
// ─────────────────────────────────────────────────────────────────────────────

/** Local gets the Monitor glyph; a WSL distro or a paired remote gets Server. */
function sourceIsLocal(source: ProjectSource): boolean {
  return source === "local";
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
        {open ? <AddProjectFlow onClose={() => closeDialog("add-project")} /> : null}
      </DialogContent>
    </Dialog>
  );
}

export function AddProjectFlow({
  onClose,
  onAdded,
  showAddEnvironment = true,
  embedded = false,
}: {
  onClose?(): void;
  onAdded?(project: Project): void;
  showAddEnvironment?: boolean;
  embedded?: boolean;
}) {
  const bridge = useBridge();
  const [, navigate] = useLocation();
  const openDialog = useRennetStore((s) => s.uiActions.openDialog);
  const openAddProjectForSource = useRennetStore((s) => s.uiActions.openAddProjectForSource);
  const { sources, activeSource, connectSource } = useConnectionCapabilities();

  const pendingSource = useRennetStore((s) => s.ui.pendingAddProjectSource);
  const clearAddProjectSource = useRennetStore((s) => s.uiActions.clearAddProjectSource);

  // A fresh open defaults to the daemon actually attached (the browser's real host), not a
  // blind "local"; a preselection from Browse Its Projects (`pendingSource`) wins.
  const [source, setSource] = useState<ProjectSource>(
    (pendingSource as ProjectSource | undefined) ?? activeSource,
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Consume the one-shot preselection from Add Environment → Browse Its Projects. On a
  // fresh mount `source` already initialised to it above; this also switches an
  // already-open dialog and, either way, clears the pending hop so the NEXT reopen is clean.
  useEffect(() => {
    if (!pendingSource) return;
    setSource(pendingSource as ProjectSource);
    setSelectedPath(null);
    // Reset the complete state on the handoff — Browse Its Projects reuses the mounted body
    // (openDialog keeps it open), so a stale error/busy from a prior attempt must not survive
    // into the fresh preselected browse (finding 14).
    setError(undefined);
    setBusy(false);
    clearAddProjectSource();
  }, [pendingSource, clearAddProjectSource]);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const choose = useMutation("repository.choose");
  const discover = useMutation("project.discover");
  // `settings.get` too: it carries the per-repo settings ROW for each project, and the
  // Projects surface derives from that row whether this daemon serves the per-project
  // rung. Without this, a freshly added project rendered its editors disabled against a
  // daemon that can write them, until something else happened to stale the read.
  const addProject = useMutation("projects.add", {
    invalidates: ["projects.list", "settings.get"],
  });

  // A per-mount guard: this body remounts on each open, so an add() that resolves AFTER the
  // user closed (and maybe reopened) the dialog must NOT run its post-await UI effects —
  // otherwise a stale completion closes the freshly-reopened dialog and hijacks the route.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const current = sources.find((option) => option.id === source) ?? sources[0];

  async function selectSource(next: ProjectSource): Promise<void> {
    setSourceOpen(false);
    if (next === source) return;
    // The daemon for this source is already attached (Local, or the current one): browse it
    // inline — the DirectoryBrowser's `reloadKey` is the source, so it remounts its listing.
    if (next === activeSource) {
      setSource(next);
      setSelectedPath(null);
      setError(undefined);
      return;
    }
    // A different daemon: attach it. `connectSource` REMOUNTS the whole app onto that daemon;
    // reopen Add Project preselected to `next` (through the store, which survives the remount)
    // so the freshly-mounted browser lists ITS filesystem — the same hop Browse Its Projects uses.
    const result = await connectSource(next, "repo");
    if (result.switched) {
      openAddProjectForSource(next);
      return; // this mount is tearing down
    }
    // No switch (already attached under another id, or an attach error): browse inline.
    setSource(next);
    setSelectedPath(null);
    setError(result.error);
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
      // A stale completion (the dialog was closed/reopened while this was in flight) must not
      // close the reopened dialog or hijack the route — bail before any post-await UI effect.
      if (!alive.current) return;
      // Persisted with no orchestrator turn; the sidebar (projects.list, invalidated above)
      // carries it. The daemon already owns the durable processing run started by projects.add;
      // the indexing view joins it without making navigation wait.
      onClose?.();
      if (onAdded) onAdded(project);
      else navigate(projectIndexingPath(project.id));
    } catch (reason) {
      if (!alive.current) return;
      setError(messageFrom(reason));
      setBusy(false);
    }
  }

  return (
    <>
      {embedded ? (
        <div className="grid gap-1.5 text-left">
          <h2 className="font-display text-lg font-semibold text-ink">Add project</h2>
          <p className="text-sm text-ink-soft">Pick a source and a folder of repositories.</p>
        </div>
      ) : (
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>Pick a source and a folder of repositories.</DialogDescription>
        </DialogHeader>
      )}

      <Popover open={sourceOpen} onOpenChange={setSourceOpen}>
        <PopoverTrigger
          aria-label={`Source: ${current?.label ?? "none"}`}
          render={<Button variant="outline" className="w-full justify-between" />}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon
              icon={current && sourceIsLocal(current.id) ? Monitor : Server}
              className="size-4 flex-none text-ink-faint"
            />
            <span className="truncate">{current?.label}</span>
          </span>
          <Icon icon={ChevronDown} className="size-4 flex-none text-ink-faint" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--anchor-width) min-w-56 gap-0 p-1">
          {sources.map((option) => (
            <button
              key={option.id}
              type="button"
              className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-sm text-ink hover:bg-raised sm:py-1.5"
              onClick={() => void selectSource(option.id)}
            >
              <Icon
                icon={sourceIsLocal(option.id) ? Monitor : Server}
                className="size-4 flex-none text-ink-faint"
              />
              <span className="flex-1 truncate">{option.label}</span>
              {option.id === current?.id ? (
                <Icon icon={Check} className="size-4 flex-none" />
              ) : null}
            </button>
          ))}
          {showAddEnvironment ? (
            <>
              <Separator className="my-1" />
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-sm text-ink hover:bg-raised sm:py-1.5"
                onClick={() => {
                  setSourceOpen(false);
                  openDialog("add-environment");
                }}
              >
                <Icon icon={Plus} className="size-4 flex-none text-ink-faint" />
                Add Environment
              </button>
            </>
          ) : null}
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
        {onClose ? (
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        <Button onClick={() => void add()} disabled={!selectedPath || busy}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </DialogFooter>
    </>
  );
}
