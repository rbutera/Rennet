"use client"

import * as React from "react"
import { ArrowLeft, Check, ChevronDown, Layers, Monitor, Plus, Server } from "lucide-react"
import { cn } from "@/lib/utils"
import type { HostItem, ProjectItem } from "@/lib/sidebar-data"
import {
  type GuidanceRule,
  hostSettings,
  keyCommands,
  projectSettings,
  type SettingsLayer,
} from "@/lib/settings-data"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/**
 * Settings as a main-surface location (ticket #476): the chat column stays
 * alive beside it; view switcher + Hand off are hidden; back arrow / Esc
 * leave. Three scopes: client (this machine), project (repo ladder rows with
 * provenance), host (the daemon serving the selected project's source).
 */
export function SettingsView({
  hosts,
  activeProjectId,
  onClose,
}: {
  hosts: HostItem[]
  activeProjectId: string
  onClose: () => void
}) {
  const [projectId, setProjectId] = React.useState(activeProjectId)
  const [scheme, setScheme] = React.useState<"system" | "dark" | "light">("system")
  const [guidanceByProject, setGuidanceByProject] = React.useState<Record<string, GuidanceRule[]>>(
    () => Object.fromEntries(Object.entries(projectSettings).map(([id, s]) => [id, s.guidance])),
  )

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  const host = hosts.find((h) => h.projects.some((p) => p.id === projectId)) ?? hosts[0]
  const project = host.projects.find((p) => p.id === projectId) ?? host.projects[0]
  const repo = projectSettings[project.id]
  const guidance = guidanceByProject[project.id] ?? []

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
        </button>
        <span className="text-[13px] font-medium text-foreground">Settings</span>
        <kbd className="ml-auto rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
          esc
        </kbd>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-8 px-8 py-8">
          <Section title="This machine" caption="~/.rennet/client-settings.json">
            <Row label="Appearance">
              <Segmented
                options={["system", "dark", "light"]}
                value={scheme}
                onChange={(v) => setScheme(v as typeof scheme)}
              />
            </Row>
            <Row label="Keyboard shortcuts" stacked>
              <div className="flex flex-col">
                {keyCommands.map((command) => (
                  <div
                    key={command.id}
                    className="group flex h-8 items-center justify-between rounded-md px-2 hover:bg-secondary/50"
                  >
                    <span className="text-[13px] text-foreground/90">{command.label}</span>
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        className="hidden rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground group-hover:block"
                      >
                        Change
                      </button>
                      <kbd className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {command.keys}
                      </kbd>
                    </span>
                  </div>
                ))}
              </div>
            </Row>
          </Section>

          <Section
            title="Project"
            titleExtra={
              <ProjectPicker hosts={hosts} value={project} onChange={(p) => setProjectId(p.id)} />
            }
            caption={`.rennet/ in ${project.name}`}
          >
            <Row label="Review context" hint="whether .rennet is visible to git">
              <LayerChip layer={repo.visibility.layer} />
              <Segmented options={["local", "git-visible"]} value={repo.visibility.value} onChange={() => {}} />
            </Row>
            <Row label="Promotion" hint="review context committed and shared via the repo">
              <span className="text-[12px] text-muted-foreground">
                {repo.promoted ? "promoted" : "not promoted"}
              </span>
            </Row>
            <Row label="Runs on" hint="where this project's commands run">
              <LayerChip layer={repo.locus.layer} />
              <span className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] text-foreground/90">
                {host.kind === "local" ? (
                  <Monitor className="size-3 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <Server className="size-3 text-muted-foreground" aria-hidden="true" />
                )}
                {repo.locus.value}
              </span>
            </Row>
            <Row label="Guidance" hint="repo rules the review agents read" stacked>
              <GuidanceList
                rules={guidance}
                onChange={(rules) =>
                  setGuidanceByProject((prev) => ({ ...prev, [project.id]: rules }))
                }
              />
            </Row>
          </Section>

          <Section title="Rennet hosts" caption="~/.rennet/daemon-settings.json on each host">
            {hosts.map((h) => {
              const daemon = hostSettings[h.id]
              return (
                <div key={h.id} className="flex flex-col gap-1 py-2.5">
                  <div className="flex items-center gap-1.5">
                    {h.kind === "local" ? (
                      <Monitor className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <Server className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    )}
                    <span className="text-[13px] font-medium text-foreground">{h.label}</span>
                  </div>
                  <div className="flex min-h-8 items-center gap-3 pl-5">
                    <span className="text-[13px] text-foreground/90">GitHub</span>
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      {daemon.github.connected ? (
                        <>
                          <span className="text-[13px] text-foreground/90">{daemon.github.account}</span>
                          <button
                            type="button"
                            className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                          >
                            Disconnect
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="text-[12px] text-muted-foreground">not connected</span>
                          <button
                            type="button"
                            className="rounded-md border border-border px-2 py-1 text-[12px] text-foreground/90 hover:bg-secondary"
                          >
                            Connect GitHub
                          </button>
                          <button
                            type="button"
                            className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                          >
                            Use a token instead
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                </div>
              )
            })}
          </Section>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  titleExtra,
  caption,
  children,
}: {
  title: string
  titleExtra?: React.ReactNode
  caption: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 text-[15px] font-medium text-foreground">
          {title}
          {titleExtra}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground/60">{caption}</span>
      </div>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border px-3">
        {children}
      </div>
    </section>
  )
}

function Row({
  label,
  hint,
  stacked,
  children,
}: {
  label: string
  hint?: string
  stacked?: boolean
  children: React.ReactNode
}) {
  if (stacked) {
    return (
      <div className="flex flex-col gap-1.5 py-2.5">
        <div className="flex flex-col">
          <span className="text-[13px] font-medium text-foreground">{label}</span>
          {hint && <span className="text-[12px] text-muted-foreground">{hint}</span>}
        </div>
        {children}
      </div>
    )
  }
  return (
    <div className="flex min-h-11 items-center gap-3 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        {hint && <span className="text-[12px] text-muted-foreground">{hint}</span>}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: string[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-card/40 p-0.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={cn(
            "rounded-[5px] px-2 py-0.5 text-[12px] transition-colors",
            option === value ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

const SEVERITY_CHIP: Record<GuidanceRule["severity"], string> = {
  high: "bg-destructive/15 text-destructive",
  medium: "bg-primary/15 text-primary",
  low: "bg-secondary text-muted-foreground",
}

function GuidanceList({
  rules,
  onChange,
}: {
  rules: GuidanceRule[]
  onChange: (rules: GuidanceRule[]) => void
}) {
  const [editing, setEditing] = React.useState<number | "new" | null>(null)
  const [draftText, setDraftText] = React.useState("")
  const [draftSeverity, setDraftSeverity] = React.useState<GuidanceRule["severity"]>("medium")

  function openEditor(index: number | "new") {
    if (index === "new") {
      setDraftText("")
      setDraftSeverity("medium")
    } else {
      setDraftText(rules[index].rule)
      setDraftSeverity(rules[index].severity)
    }
    setEditing(index)
  }

  function save() {
    const text = draftText.trim()
    if (!text) return
    const next = { rule: text, severity: draftSeverity }
    onChange(editing === "new" ? [...rules, next] : rules.map((r, i) => (i === editing ? next : r)))
    setEditing(null)
  }

  function remove(index: number) {
    onChange(rules.filter((_, i) => i !== index))
    setEditing(null)
  }

  const editor = (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-secondary/40 px-2.5 py-2">
      <textarea
        autoFocus
        value={draftText}
        onChange={(event) => setDraftText(event.target.value)}
        onKeyDown={(event) => {
          // Esc must close the editor, not the settings view (window listener).
          if (event.key === "Escape") {
            event.stopPropagation()
            setEditing(null)
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            save()
          }
        }}
        placeholder="State the rule…"
        rows={1}
        className="w-full resize-none rounded-md border border-border bg-card px-2 py-1.5 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
      />
      <div className="flex items-center gap-2">
        <Segmented
          options={["high", "medium", "low"]}
          value={draftSeverity}
          onChange={(v) => setDraftSeverity(v as GuidanceRule["severity"])}
        />
        <div className="ml-auto flex items-center gap-1">
          {editing !== "new" && editing !== null && (
            <button
              type="button"
              onClick={() => remove(editing)}
              className="rounded-md px-2 py-1 text-[12px] font-medium text-destructive hover:bg-destructive/10"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!draftText.trim()}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
              draftText.trim()
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground",
            )}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-1">
      {rules.map((rule, index) =>
        editing === index ? (
          <React.Fragment key={rule.rule}>{editor}</React.Fragment>
        ) : (
          <div key={rule.rule} className="group flex items-center gap-2 rounded-md px-2 py-0.5 hover:bg-secondary/50">
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                SEVERITY_CHIP[rule.severity],
              )}
            >
              {rule.severity}
            </span>
            <span className="text-[13px] text-foreground/90">{rule.rule}</span>
            <button
              type="button"
              onClick={() => openEditor(index)}
              className="ml-auto hidden shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground group-hover:block"
            >
              Edit
            </button>
          </div>
        ),
      )}
      {editing === "new" ? (
        editor
      ) : (
        <button
          type="button"
          onClick={() => openEditor("new")}
          className="flex h-7 w-fit items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Plus className="size-3" aria-hidden="true" />
          Add rule
        </button>
      )}
    </div>
  )
}

/** Which ladder rung produced the effective value (provenance, ticket #476). */
function LayerChip({ layer }: { layer: SettingsLayer }) {
  return (
    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground" title={`resolved from the ${layer} layer`}>
      {layer}
    </span>
  )
}

export function ProjectPicker({
  hosts,
  value,
  onChange,
}: {
  hosts: HostItem[]
  value: ProjectItem
  onChange: (project: ProjectItem) => void
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[13px] font-normal text-foreground/90 hover:bg-secondary"
          >
            <Layers className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {value.name}
            <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
          </button>
        }
      />
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search projects" />
          <CommandList>
            <CommandEmpty>No projects found.</CommandEmpty>
            {hosts.map((host) => (
              <CommandGroup key={host.id} heading={host.label}>
                {host.projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    onSelect={() => {
                      onChange(project)
                      setOpen(false)
                    }}
                  >
                    <Layers className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    <span className="flex-1">{project.name}</span>
                    {project.id === value.id && <Check className="size-3.5" aria-hidden="true" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
