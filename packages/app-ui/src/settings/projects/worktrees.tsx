import { cn } from "@rennet/ui";
import type { KeyboardEvent } from "react";
import type { SidebarProject } from "../../shell/sidebar-data";
import {
  DEFAULT_WORKTREE_PATTERN,
  DEFAULT_WORKTREE_ROOT,
  previewWorktreeName,
  WORKTREE_TOKENS,
} from "../assets/worktree";
import { Row, Section } from "../atoms";
import { useSettingsProjection } from "../data";
import { UnbackedNote } from "./unbacked-note";

// ─────────────────────────────────────────────────────────────────────────────
// The Projects → Worktrees section (C10 §8.3, claims 653–655). The location
// directory and the naming pattern, the pattern's insertable tokens
// (`{project}`/`{branch}`/`{pr}`/`{user}`/`{date}`), and the live preview of the
// resolved worktree path — branch slashes flattened to dashes. Both fields ride the
// settings projection (`setWorktreeRoot` / `setWorktreePattern`), so an edit persists
// and the preview recomputes; a project with no override reads the client defaults.
// ─────────────────────────────────────────────────────────────────────────────

/** Escape blurs the field WITHOUT closing the settings takeover (the root handler). */
function stopEscape(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === "Escape") {
    event.stopPropagation();
    event.currentTarget.blur();
  }
}

const FIELD =
  "w-full rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus-visible:border-accent-line focus-visible:outline-none";

export function WorktreeSection({ project }: { readonly project: SidebarProject }) {
  const projection = useSettingsProjection();
  // No served write store yet ⇒ disable the fields + disclose the gap (no no-op inputs).
  const backed = projection.projectEditsPersist;
  const settings = projection.worktreeByProject[project.id];
  const root = settings?.root.value ?? DEFAULT_WORKTREE_ROOT;
  const pattern = settings?.pattern.value ?? DEFAULT_WORKTREE_PATTERN;
  const name = projection.nameByProject[project.id] ?? project.name;

  const preview = `${root.replace(/\/+$/, "")}/${previewWorktreeName(pattern, name)}`;

  return (
    <Section title="Worktrees" caption="~/.rennet/client-settings.json">
      <Row label="Location" hint="new worktrees for this project are created here" stacked>
        <input
          value={root}
          onChange={(event) => projection.setWorktreeRoot(project.id, event.target.value)}
          onKeyDown={stopEscape}
          disabled={!backed}
          aria-label="Worktree location"
          spellCheck={false}
          className={cn(FIELD, !backed && "cursor-not-allowed opacity-60")}
        />
      </Row>
      <Row label="Naming" hint="how each worktree folder is named" stacked>
        <input
          value={pattern}
          onChange={(event) => projection.setWorktreePattern(project.id, event.target.value)}
          onKeyDown={stopEscape}
          disabled={!backed}
          aria-label="Worktree naming pattern"
          spellCheck={false}
          className={cn(FIELD, !backed && "cursor-not-allowed opacity-60")}
        />
        <div className="flex flex-wrap items-center gap-1">
          {WORKTREE_TOKENS.map((t) => (
            <button
              key={t.token}
              type="button"
              onClick={() => projection.setWorktreePattern(project.id, pattern + t.token)}
              disabled={!backed}
              title={`Insert ${t.token}`}
              className="flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-2xs text-ink-soft transition-colors hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-ink-soft"
            >
              <span className="font-mono">{t.token}</span>
              <span className="text-ink-faint">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="flex items-baseline gap-2 rounded-md bg-raised/40 px-2 py-1.5">
          <span className="shrink-0 text-2xs uppercase tracking-wide text-ink-faint">Preview</span>
          <span className="truncate font-mono text-xs text-ink">{preview}</span>
        </div>
        {backed ? null : (
          <UnbackedNote>
            Worktree location and naming aren&rsquo;t served yet — this lands with the settings
            engine.
          </UnbackedNote>
        )}
      </Row>
    </Section>
  );
}
