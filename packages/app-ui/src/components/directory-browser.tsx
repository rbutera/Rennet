import type { FsEntry, RennetBridge } from "@rennet/protocol";
import { Button, cn, Input } from "@rennet/ui";
import { ArrowUp, Folder, GitBranch } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { messageFrom } from "../lib/message-from";
import { Icon } from "./icon";

/**
 * The in-app directory browser (source-aware project selection, task 5): fed by
 * the daemon's `fs.listDir` RPC, this REPLACES the native OS folder picker (task
 * 6 wires it in and deletes the native picker) so browsing works identically over
 * a remote/WSL source, where there is no native dialog to shell out to.
 *
 * Standalone here: mount + reload-on-`reloadKey`, descend by clicking/entering a
 * row, ascend via the Up affordance or Backspace, or type an absolute path into
 * the bar directly. `onPathChange` is the seam the add flow reads the chosen
 * directory back through.
 */
export function DirectoryBrowser({
  bridge,
  reloadKey,
  initialPath,
  onPathChange,
  onPathInvalid,
}: {
  bridge: RennetBridge;
  /** Bump this to force a reload (e.g. when the source changes). */
  reloadKey?: string;
  /**
   * The directory to open on mount / reload, instead of the daemon's home dir — used to
   * RESTORE a recent project's path when a source switch remounts onto its daemon. Read
   * only when a load fires (mount or `reloadKey` change), never reactively, so browsing
   * away from it does not snap back.
   */
  initialPath?: string;
  /** Called whenever the current directory changes (browse or type). */
  onPathChange(path: string): void;
  /**
   * Called when a load FAILS (bad typed path, unreachable target): the shown directory is now
   * invalid, so the flow must not treat a stale-good path as submittable — the add flow clears its
   * selected path here to keep Continue disabled (SPEC: invalid typed path → Continue disabled).
   */
  onPathInvalid?(): void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [error, setError] = useState<string>();
  const [typed, setTyped] = useState("");
  const [focusIndex, setFocusIndex] = useState(0);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Generation guard: `reloadKey` bumps on source-switch, so an in-flight load
  // from the PREVIOUS source can resolve after a newer one and must not win.
  // Each `load()` claims the next generation; a response only applies state if
  // it's still the latest generation issued when it resolves.
  const generationRef = useRef(0);
  // What the path bar holds RIGHT NOW, readable inside a load's `.then` without
  // making `load` depend on the render that issued it.
  const typedRef = useRef("");
  typedRef.current = typed;

  function load(target?: string): void {
    const generation = ++generationRef.current;
    // The bar's content when this load was issued. The generation guard above only
    // settles races between LOADS; this settles the race between a load and the
    // USER. The opening listing is asynchronous, so someone who opens the browser
    // and types immediately had their text silently replaced by the home directory
    // when it landed — input accepted and then discarded, with no sign it happened.
    const typedAtIssue = typedRef.current;
    bridge
      .invoke("fs.listDir", target ? { path: target } : {})
      .then(({ result }) => {
        if (generation !== generationRef.current) return;
        setPath(result.path);
        setParent(result.parent);
        setEntries(result.entries);
        setError(undefined);
        // Normalise the bar to the resolved path — unless the user has edited it since
        // this load was issued, in which case their keystrokes are the newer truth.
        if (typedRef.current === typedAtIssue) setTyped(result.path);
        setFocusIndex(0);
        onPathChange(result.path);
      })
      .catch((reason: unknown) => {
        if (generation !== generationRef.current) return;
        // Bad typed path: leave the bar (and the last-good listing) alone, just
        // surface the fault — the empty-on-error render comes from `rows` below.
        setError(messageFrom(reason) || "No such directory");
        // The current directory is invalid — tell the flow so it drops the selected path
        // and Continue disables (a bad path must never stay submittable).
        onPathInvalid?.();
      });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — fires on mount and whenever bridge/reloadKey change; the body reads `load`/`initialPath` fresh each render (off the same bridge) rather than a stale closure, so listing them would re-run every render. `initialPath` is a mount-time SEED, not a reactive input.
  useEffect(() => {
    load(initialPath);
  }, [bridge, reloadKey]);

  const loaded = path !== null;
  const rows = error ? [] : entries;
  const showEmpty = loaded && !error && rows.length === 0;

  function handleRowKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    index: number,
    entry: FsEntry,
  ): void {
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = Math.min(index + 1, rows.length - 1);
        setFocusIndex(next);
        rowRefs.current[next]?.focus();
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        const prev = Math.max(index - 1, 0);
        setFocusIndex(prev);
        rowRefs.current[prev]?.focus();
        break;
      }
      case "Enter":
        if (!entry.unreadable) load(entry.path);
        break;
      case "Backspace":
        if (parent !== null) load(parent);
        break;
      default:
        break;
    }
  }

  return (
    <div className="directory-browser flex flex-col gap-2.5">
      <div className="directory-browser-toolbar flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="directory-browser-up flex-none"
          onClick={() => parent !== null && load(parent)}
          disabled={parent === null}
          aria-label="Up one level"
          title="Up one level"
        >
          <Icon icon={ArrowUp} className="size-3.5" />
        </Button>
        {loaded ? <PathBreadcrumb path={path} onNavigate={load} /> : null}
      </div>

      <Input
        type="text"
        className="directory-browser-path-bar"
        aria-label="Directory path"
        value={typed}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          load(typed);
        }}
      />

      {error ? (
        <p
          className="directory-browser-error px-3 py-2 rounded-md border border-danger/50 bg-danger/10 text-ink text-13"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div
        role="listbox"
        aria-label="Directories"
        className="directory-browser-list flex flex-col gap-0.5 max-h-[min(45dvh,24rem)] min-h-32 overflow-y-auto rounded-md border border-border p-1"
      >
        {showEmpty ? (
          <div className="directory-browser-empty px-3 py-6 text-center text-sm text-ink-faint">
            No folders here
          </div>
        ) : (
          rows.map((entry, index) => (
            <div
              key={entry.path}
              role="option"
              aria-selected={index === focusIndex}
              aria-disabled={entry.unreadable}
              tabIndex={index === focusIndex ? 0 : -1}
              ref={(node) => {
                rowRefs.current[index] = node;
              }}
              className={cn(
                "directory-browser-row flex items-center gap-2.5 rounded-control px-2 py-2.5 text-13 outline-none focus-visible:ring-2 focus-visible:ring-accent-soft sm:py-1.5",
                entry.unreadable
                  ? "text-ink-faint opacity-50 cursor-not-allowed"
                  : "text-ink cursor-pointer hover:bg-raised",
              )}
              onClick={() => {
                if (entry.unreadable) return;
                setFocusIndex(index);
                load(entry.path);
              }}
              onFocus={() => setFocusIndex(index)}
              onKeyDown={(event) => handleRowKeyDown(event, index, entry)}
            >
              <Icon icon={Folder} className="size-3.5 flex-none text-ink-soft" />
              <span className="truncate">{entry.name}</span>
              {entry.isRepo ? (
                <span className="directory-browser-repo-badge ml-auto inline-flex flex-none items-center gap-1 rounded-chip border border-line px-1.5 py-0.5 text-10 text-ink-soft">
                  <Icon icon={GitBranch} className="size-3" />
                  repo
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** The current path split into clickable segments — root first, current dir last (disabled). */
function PathBreadcrumb({ path, onNavigate }: { path: string; onNavigate(path: string): void }) {
  const segments = segmentsOf(path);
  return (
    <nav
      className="directory-browser-breadcrumb flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs text-ink-faint"
      aria-label="Current path"
    >
      {segments.map((segment, index) => {
        const current = index === segments.length - 1;
        return (
          <span className="directory-browser-crumb flex items-center gap-0.5" key={segment.path}>
            {index > 0 ? (
              <span className="text-ink-faint/70" aria-hidden="true">
                /
              </span>
            ) : null}
            <button
              type="button"
              className={cn(
                "rounded px-1 py-0.5 truncate",
                current ? "text-ink font-medium" : "text-ink-soft hover:bg-raised hover:text-ink",
              )}
              aria-current={current ? "page" : undefined}
              disabled={current}
              onClick={current ? undefined : () => onNavigate(segment.path)}
            >
              {segment.label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

// ponytail: POSIX-style splitting only (daemon fs is local/WSL/remote-Linux); a
// Windows-native daemon path would need its own segmenter — add if/when task 6's
// wiring surfaces one.
function segmentsOf(path: string): { label: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const segments = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    segments.push({ label: part, path: acc });
  }
  return segments;
}
