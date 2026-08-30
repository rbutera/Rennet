import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
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
// ─────────────────────────────────────────────────────────────────────────────

export function ProjectPicker({
  hosts,
  value,
  onChange,
}: {
  readonly hosts: readonly SidebarHost[];
  /** The active project id (resolved from `?project`). */
  readonly value: string;
  readonly onChange: (projectId: string) => void;
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
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm font-normal text-ink transition-colors hover:bg-raised"
          />
        }
      >
        <ProjectIcon
          icon={active ? (projection.glyphByProject[active.id] ?? DEFAULT_PROJECT_ICON) : undefined}
          className="size-3.5 text-ink-soft"
        />
        {active ? displayName(active.id, active.name) : "No project"}
        <Icon icon={ChevronDown} className="size-3 text-ink-soft" />
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
                    value={displayName(project.id, project.name)}
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
