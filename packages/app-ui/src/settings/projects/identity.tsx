import { cn, Toggle, ToggleGroup } from "@rennet/ui";
import { RotateCcw } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { Icon } from "../../components/icon";
import type { SidebarProject } from "../../shell/sidebar-data";
import {
  DEFAULT_PROJECT_ICON,
  PROJECT_ICON_NAMES,
  ProjectIcon,
  type ProjectIconName,
} from "../assets/project-icon";
import { Row, Section } from "../atoms";
import { useSettingsProjection } from "../data";
import { UnbackedNote } from "./unbacked-note";

// ─────────────────────────────────────────────────────────────────────────────
// The Projects → Identity section (C10 §8.2, claims 649–652). The display name
// (the `org/repo` default as placeholder, a Reset when renamed, the default restored
// on an emptied commit) and the glyph grid.
//
// The two rows persist to DIFFERENT stores, which is why the caption names both: the
// NAME writes through `project.rename` into the projects store (`projects.json`) — the
// same write the sidebar's rename calls — while the glyph is a client-settings fact with
// no served write yet, so it stays disabled and says so.
//
// The glyph grid is the kit's single-select `ToggleGroup` (autopsy S6 forbids the
// spike's hand-rolled `role="radiogroup"`), restyled to square icon cells.
// ─────────────────────────────────────────────────────────────────────────────

/** Escape clears the field WITHOUT closing the settings takeover (the root handler). */
function stopEscape(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "Escape") {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).blur();
  }
}

export function IdentitySection({ project }: { readonly project: SidebarProject }) {
  const projection = useSettingsProjection();
  // No served write store yet ⇒ show the controls disabled + disclose the gap, never
  // an enabled field bound to the projection's no-op setter (which would eat input).
  const backed = projection.projectEditsPersist;
  // The name writes through `project.rename` (C18) even where the glyph does not, so the
  // field is enabled on its own truth rather than on the unserved editors' flag.
  const nameBacked = projection.nameEditsPersist;
  const name = projection.nameByProject[project.id] ?? project.name;
  const glyph = projection.glyphByProject[project.id] ?? DEFAULT_PROJECT_ICON;
  const renamed = nameBacked && name !== project.fallbackName;
  // The field holds a LOCAL draft and commits on blur/Enter — the same shape the sidebar's
  // session rename uses. `setProjectName` is a served write (`project.rename` persists to
  // the projects store), so a per-keystroke binding would write once per character and, on
  // a controlled input, drop characters whenever the round trip lagged the typing.
  const [draft, setDraft] = useState<string | null>(null);

  function commitName() {
    if (draft === null) return;
    // An emptied name never persists — it falls back to the org/repo default (R67).
    projection.setProjectName(project.id, draft.trim() || project.fallbackName);
    setDraft(null);
  }

  return (
    <Section title="Identity" caption="~/.rennet/projects.json · ~/.rennet/client-settings.json">
      <Row label="Name" hint={`defaults to ${project.fallbackName}`}>
        {renamed ? (
          <button
            type="button"
            onClick={() => {
              setDraft(null);
              projection.setProjectName(project.id, project.fallbackName);
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-soft transition-colors hover:bg-raised hover:text-ink"
          >
            <Icon icon={RotateCcw} className="size-3" />
            Reset
          </button>
        ) : null}
        <input
          value={draft ?? name}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitName();
            stopEscape(event);
          }}
          disabled={!nameBacked}
          aria-label="Project name"
          placeholder={project.fallbackName}
          className={cn(
            "w-56 rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink placeholder:text-ink-faint focus-visible:border-accent-line focus-visible:outline-none",
            !nameBacked && "cursor-not-allowed opacity-60",
          )}
        />
      </Row>
      <Row label="Glyph" hint="shown next to the project in the sidebar" stacked>
        <ToggleGroup
          aria-label="Project glyph"
          value={[glyph]}
          disabled={!backed}
          onValueChange={(next: string[]) => {
            const picked = next[0] as ProjectIconName | undefined;
            if (picked) projection.setProjectGlyph(project.id, picked);
          }}
          className="flex w-auto flex-wrap gap-1 bg-transparent p-0"
        >
          {PROJECT_ICON_NAMES.map((iconName) => (
            <Toggle
              key={iconName}
              value={iconName}
              aria-label={iconName}
              title={iconName}
              variant="outline"
              className={cn(
                "size-8 rounded-md border-transparent p-0 text-ink-soft",
                "hover:bg-raised/60 hover:text-ink",
                "data-pressed:border-accent-line data-pressed:bg-raised data-pressed:text-ink",
              )}
            >
              <ProjectIcon icon={iconName} className="size-4" />
            </Toggle>
          ))}
        </ToggleGroup>
      </Row>
      {backed ? null : (
        <div className="py-2.5">
          <UnbackedNote>
            Glyphs aren&rsquo;t served yet — this lands with the settings engine.
          </UnbackedNote>
        </div>
      )}
    </Section>
  );
}
