import type { PrWorktreeSetup, RennetBridge } from "@rennet/protocol";
import { useEffect, useState } from "react";

/**
 * The reviewed PR's worktree line (historical-PR review): where the detached
 * checkout at the reviewed head lives and how its `.rennet/setup` run went.
 * Renders nothing for a review with no worktree (a working-tree capture). While
 * setup is running the status polls until it settles; a failure shows the log
 * tail inline — honest visibility, never a wall (the review works regardless).
 */
export function PrWorktreeStatus({
  bridge,
  reviewId,
  scheme,
}: {
  bridge: RennetBridge;
  reviewId: string;
  scheme?: "dark" | "light";
}) {
  const [worktree, setWorktree] = useState<{
    path: string;
    setup: PrWorktreeSetup;
    logTail: string;
  } | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load(): Promise<void> {
      try {
        const { worktree: next } = await bridge.invoke("review.prWorktree", { reviewId });
        if (cancelled) return;
        setWorktree(next);
        if (next?.setup.status === "running") timer = setTimeout(load, 2000);
      } catch {
        // A failed read renders as no line — the review itself is unaffected.
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [bridge, reviewId]);

  if (!worktree) return null;
  const { setup } = worktree;
  const setupLabel =
    setup.status === "none"
      ? "no setup file"
      : setup.status === "running"
        ? "setup running…"
        : setup.status === "ok"
          ? "setup ok"
          : `setup failed (${setup.command} → exit ${setup.exitCode})`;
  return (
    <div className="rennet-glass contents" data-scheme={scheme ?? "dark"}>
      <section
        className="pr-worktree-status flex flex-wrap items-center gap-2.5 px-[18px] py-2 text-xs text-ink-faint"
        role="note"
        data-testid="pr-worktree-status"
      >
        <span className="font-semibold uppercase tracking-wide text-2xs">Worktree</span>
        <span className="font-mono truncate text-ink-soft" title={worktree.path}>
          {worktree.path}
        </span>
        <span
          className={
            setup.status === "failed"
              ? "text-danger"
              : setup.status === "ok"
                ? "text-ink-soft"
                : "text-ink-faint"
          }
        >
          {setupLabel}
        </span>
        {setup.status === "failed" && worktree.logTail ? (
          <button
            type="button"
            className="underline text-ink-soft hover:text-ink"
            onClick={() => setLogOpen((open) => !open)}
          >
            {logOpen ? "Hide log" : "Show log"}
          </button>
        ) : null}
        {logOpen ? (
          <pre className="basis-full m-0 max-h-48 overflow-auto rounded-chip border border-line bg-surface p-2.5 font-mono text-2xs text-ink-soft">
            {worktree.logTail}
          </pre>
        ) : null}
      </section>
    </div>
  );
}
