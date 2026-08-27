import type { Project } from "@rennet/protocol";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@rennet/ui";
import { ArrowUp, Check, ChevronDown, GitBranch, Map as MapIcon, MoveLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Icon } from "../components/icon";
import { useCommand } from "../data";
import { newChatPath, projectMapPath } from "../routes/url";

// ─────────────────────────────────────────────────────────────────────────────
// The New Chat view (C12 §10.8, /new-chat?project=…). A full-view takeover — there
// is no session yet, so no chat column. The header carries the project › New Chat
// trail, a Map control, and the esc hint; Escape closes the page. The headline asks
// "What should we review in <project>?" with the project name as a headline-sized
// inline picker — changing it resets the target and rewrites the URL. A bottom
// composer carries the review target as a chip (X resets to the current checkout)
// and its Send is inert while empty.
//
// The smart list (the review-target picker) is cluster 6.2; live session minting
// from a row is the GATED cluster 7 (B9) behind `new-chat-mint.ts`. Cluster 6 builds
// every surface it can against the projection seam — selection, not minting.
// ─────────────────────────────────────────────────────────────────────────────

/** The chosen review target: the whole-project current checkout (default), or a row
 *  from the smart list (cluster 6.2). Kept as a union so 6.2 slots the row in. */
export type NewChatTarget = { readonly kind: "checkout" };

export function NewChatView({ projectId }: { readonly projectId: string }) {
  const [, navigate] = useLocation();
  const { data: projectsData } = useCommand("projects.list", {});
  const projects = projectsData?.projects ?? [];
  const project = projects.find((candidate) => candidate.id === projectId);

  const [target, setTarget] = useState<NewChatTarget>({ kind: "checkout" });
  const [message, setMessage] = useState("");

  const close = () => navigate(newChatPath());

  // Escape closes the page (the filter input's own Escape stops there first — 6.2).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Switching project rewrites the URL; reset the target back to the checkout. projectId
  // is the intended run trigger — the effect fires ON a project change to drop a stale
  // row selection (6.2), it does not read projectId in its body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId is a run trigger, not a body reference.
  useEffect(() => {
    setTarget({ kind: "checkout" });
  }, [projectId]);

  const branch = project?.primaryBranch ?? "main";

  return (
    <section
      data-screen="new-chat"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-canvas"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <button
          type="button"
          onClick={close}
          aria-label="Back"
          className="flex size-7 items-center justify-center rounded-control text-ink-faint hover:bg-raised hover:text-ink"
        >
          <Icon icon={MoveLeft} className="size-4" />
        </button>
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="shrink-0 text-ink-soft">{project?.name ?? projectId}</span>
          <span className="text-ink-faint">›</span>
          <span className="font-medium text-ink">New Chat</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate(projectMapPath(projectId))}
            className="flex items-center gap-1.5 rounded-control border border-line px-2 py-1 text-xs font-medium text-ink-soft hover:bg-raised hover:text-ink"
          >
            <Icon icon={MapIcon} className="size-3.5" />
            Map
          </button>
          <kbd className="rounded-chip border border-line px-1.5 py-0.5 text-2xs text-ink-faint">
            esc
          </kbd>
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col px-8 pt-[7vh] pb-6">
          <h1 className="flex flex-wrap items-baseline justify-center gap-2 text-center font-display text-2xl font-medium tracking-tight text-ink">
            What should we review in
            <ProjectPicker
              projects={projects}
              current={project}
              onChange={(next) => navigate(newChatPath(next.id))}
            />
            ?
          </h1>

          {/* Smart list (the review-target picker) — cluster 6.2. */}
        </div>
      </div>

      <Composer
        target={target}
        branch={branch}
        message={message}
        onMessage={setMessage}
        onResetTarget={() => setTarget({ kind: "checkout" })}
      />
    </section>
  );
}

/** The headline-sized inline project picker — a Popover of the project list, matching
 *  the Add Project source picker. Choosing a project rewrites the URL (the parent). */
function ProjectPicker({
  projects,
  current,
  onChange,
}: {
  readonly projects: readonly Project[];
  readonly current: Project | undefined;
  readonly onChange: (project: Project) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Project: ${current?.name ?? "none"}`}
        render={
          <button
            type="button"
            className="inline-flex items-baseline gap-1 rounded-control px-1.5 text-accent underline decoration-accent-line decoration-dotted underline-offset-4 hover:bg-raised"
          />
        }
      >
        {current?.name ?? "a project"}
        <Icon icon={ChevronDown} className="size-4 flex-none self-center text-ink-faint" />
      </PopoverTrigger>
      <PopoverContent align="center" className="min-w-56 gap-0 p-1">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-base text-ink hover:bg-raised"
            onClick={() => {
              setOpen(false);
              if (project.id !== current?.id) onChange(project);
            }}
          >
            <span className="flex-1 truncate">{project.name}</span>
            {project.id === current?.id ? (
              <Icon icon={Check} className="size-4 flex-none text-accent" />
            ) : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function Composer({
  target,
  branch,
  message,
  onMessage,
  onResetTarget,
}: {
  readonly target: NewChatTarget;
  readonly branch: string;
  readonly message: string;
  readonly onMessage: (value: string) => void;
  readonly onResetTarget: () => void;
}) {
  return (
    <div className="shrink-0 px-8 pt-2 pb-5">
      <div className="mx-auto flex w-full max-w-[720px] flex-col rounded-surface border border-line bg-surface focus-within:border-accent-line">
        <textarea
          value={message}
          onChange={(event) => onMessage(event.target.value)}
          placeholder="Message the orchestrator"
          rows={3}
          aria-label="Message the orchestrator"
          className="w-full resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus-visible:outline-none"
        />
        <div className="flex items-center gap-2 px-3 pt-1 pb-2.5">
          <span className="flex items-center gap-1.5 rounded-chip border border-line bg-raised px-2 py-1 text-xs text-ink-soft">
            <Icon icon={GitBranch} className="size-3 text-ink-faint" />
            Current Checkout · {branch}
            {target.kind !== "checkout" ? (
              <button
                type="button"
                onClick={onResetTarget}
                aria-label="Reset target to current checkout"
                className="flex size-3.5 items-center justify-center rounded-sm text-ink-faint hover:bg-raised hover:text-ink"
              >
                ×
              </button>
            ) : null}
          </span>
          <button
            type="button"
            disabled={!message.trim()}
            aria-label="Send"
            // Live minting is the GATED cluster 7 (B9) — the surface stops at the
            // typed ask + target here; no fake session is started.
            className={cn(
              "ml-auto flex size-8 shrink-0 items-center justify-center rounded-control transition-colors disabled:cursor-not-allowed",
              message.trim()
                ? "bg-accent-fill text-accent-ink hover:opacity-90"
                : "bg-raised text-ink-faint",
            )}
          >
            <Icon icon={ArrowUp} className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
