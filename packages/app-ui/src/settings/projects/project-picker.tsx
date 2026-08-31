import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rennet/ui";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Icon } from "../../components/icon";
import type { SidebarHost } from "../../shell/sidebar-data";
import { DEFAULT_PROJECT_ICON, ProjectIcon } from "../assets/project-icon";
import { useSettingsProjection } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// The Projects-page scope picker (C10 §8.1, claims 647–648). A single inline
// picker, grouped by ENVIRONMENT — the same host grouping the sidebar uses, from the
// real `projects.list` tree (dual-source: identity from the tree, glyph + name from
// the settings projection). Ported from the spike's `ProjectPicker` (Popover +
// Command), rewired onto Rennet's tokens and the live tree.
//
// The picker does NOT own the scope: it emits `onChange(projectId)` and the page
// navigates `?project`, so the URL is the single source of the active project (the
// structural rule — no shadowed `useState` page scope).
//
// TWO call sites, one component: the Projects page's inline scope picker, and New Chat's
// headline picker (`large`). `large` sets NO text size on purpose — it sits inside the
// New Chat `<h1>` and inherits that headline's display face and size, which is what
// "headline-sized inline picker" means.
// ─────────────────────────────────────────────────────────────────────────────

export function ProjectPicker({
  hosts,
  value,
  onChange,
  large,
}: {
  readonly hosts: readonly SidebarHost[];
  /** The active project id (resolved from `?project`). */
  readonly value: string;
  readonly onChange: (projectId: string) => void;
  /** Headline-sized trigger — New Chat's "What should we review in <project>?" sits the
   *  picker INSIDE its headline, so the pill grows to the headline's type and glyph size
   *  while the popover stays identical (spike `settings-view.tsx` ProjectPicker `large`). */
  readonly large?: boolean;
}) {
  const projection = useSettingsProjection();
  const [open, setOpen] = useState(false);

  const projects = hosts.flatMap((host) => host.projects);
  const active = projects.find((p) => p.id === value);
  const displayName = (id: string, fallback: string) => projection.nameByProject[id] ?? fallback;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Choose project"
            className={cn(
              "flex items-center rounded-md border border-line font-normal text-ink transition-colors hover:bg-raised",
              large ? "gap-1.5 px-2.5 py-1" : "gap-1.5 px-2 py-0.5 text-13",
            )}
          />
        }
      >
        <ProjectIcon
          icon={active ? (projection.glyphByProject[active.id] ?? DEFAULT_PROJECT_ICON) : undefined}
          className={cn(large ? "size-5" : "size-3.5", "text-ink-soft")}
        />
        {active ? displayName(active.id, active.name) : "No project"}
        <Icon icon={ChevronDown} className={cn(large ? "size-4" : "size-3", "text-ink-soft")} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search projects" className="text-xs" />
          <CommandList>
            <CommandEmpty>No projects found.</CommandEmpty>
            {hosts.map((host) => (
              <CommandGroup key={host.id} heading={host.label}>
                {host.projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    // cmdk's `value` is the row's IDENTITY, not its label: it decides which
                    // row is highlighted (`aria-selected` compares the store value to the
                    // item's) and which one Enter selects. Two projects with the same display
                    // name on different hosts — a workspace and its clone, `rennet` on local
                    // and on lancelot — collapsed into one identity under the name: both rows
                    // lit, ArrowDown could not move between them, and Enter always took the
                    // first. Host-qualified, so identity is unique even when the label is not.
                    value={`${host.id}/${project.id}`}
                    // Search still matches what the reviewer can READ. cmdk scores value +
                    // keywords, and the value is now an id nobody types.
                    keywords={[displayName(project.id, project.name), host.label]}
                    // The tick is the kit's own trailing column now (CommandItem renders it
                    // off `data-checked`), so the row no longer carries a second one.
                    data-checked={project.id === value}
                    onSelect={() => {
                      onChange(project.id);
                      setOpen(false);
                    }}
                    className="text-xs"
                  >
                    <ProjectIcon
                      icon={projection.glyphByProject[project.id] ?? DEFAULT_PROJECT_ICON}
                      className="size-3.5 text-ink-soft"
                    />
                    <span className="flex-1">{displayName(project.id, project.name)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
