"use client"

import * as React from "react"
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Keyboard,
  Layers,
  Monitor,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Server,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { OS_GLYPHS } from "@/lib/os-glyphs"
import { useAppStore } from "@/lib/store"
import { THEME_PACKS } from "@/lib/theme-packs"
import { CODE_THEMES } from "@/lib/code-theme"
import type { HostItem, ProjectItem } from "@/lib/sidebar-data"
import { PROJECT_ICONS, ProjectIcon, type ProjectIconName } from "@/components/project-icon"
import {
  type AgentTool,
  agentTools,
  CLAUDE_MODELS,
  CODEX_MODELS,
  defaultWorktrees,
  type EnvironmentInfo,
  environments,
  type GuidanceRule,
  keyCommands,
  LATEST_DAEMON,
  previewWorktreeName,
  projectSettings,
  REVIEW_MODES,
  type ReviewMode,
  type ReviewRole,
  reviewRoles,
  type RoleAssignment,
  type SettingsLayer,
  type SettingsPage,
  sourceControl,
  type SourceControlTool,
  worktreeTokens,
  type WorktreeSettings,
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
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * Settings as a main-surface location (ticket #476): the chat column stays
 * alive beneath it; view switcher + Hand off are hidden; back arrow / Esc
 * leave. Split into pages — This machine (client + hosts), Keyboard
 * shortcuts, and Projects — because the per-project surface grows large.
 */
export function SettingsView({
  hosts,
  initialPage = "machine",
  activeProjectId,
  onClose,
  onRenameProject,
  onSetProjectIcon,
}: {
  hosts: HostItem[]
  initialPage?: SettingsPage
  activeProjectId: string
  onClose: () => void
  onRenameProject: (projectId: string, name: string) => void
  onSetProjectIcon: (projectId: string, icon: ProjectIconName) => void
}) {
  const [page, setPage] = React.useState<SettingsPage>(initialPage)
  const [projectId, setProjectId] = React.useState(activeProjectId)

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  const host = hosts.find((h) => h.projects.some((p) => p.id === projectId)) ?? hosts[0]
  const project = host.projects.find((p) => p.id === projectId) ?? host.projects[0]

  const PAGES: { id: SettingsPage; label: string; icon: React.ReactNode }[] = [
    { id: "machine", label: "Environments", icon: <Monitor className="size-3.5" aria-hidden="true" /> },
    { id: "appearance", label: "Appearance", icon: <Palette className="size-3.5" aria-hidden="true" /> },
    { id: "shortcuts", label: "Keyboard Shortcuts", icon: <Keyboard className="size-3.5" aria-hidden="true" /> },
    { id: "projects", label: "Projects", icon: <Layers className="size-3.5" aria-hidden="true" /> },
  ]

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

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border px-2 py-4" aria-label="Settings pages">
          {PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPage(p.id)}
              aria-current={page === p.id ? "page" : undefined}
              className={cn(
                "flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors",
                page === p.id
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
              )}
            >
              <span className={cn(page === p.id ? "text-foreground" : "text-muted-foreground")}>{p.icon}</span>
              {p.label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[640px] flex-col gap-8 px-8 py-8">
            {page === "machine" && <MachinePage hosts={hosts} />}
            {page === "appearance" && <AppearancePage />}
            {page === "shortcuts" && <ShortcutsPage />}
            {page === "projects" && (
              <ProjectsPage
                hosts={hosts}
                host={host}
                project={project}
                onProjectChange={(p) => setProjectId(p.id)}
                onRenameProject={onRenameProject}
                onSetProjectIcon={onSetProjectIcon}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function AppearancePage() {
  const scheme = useAppStore((s) => s.scheme)
  const themePack = useAppStore((s) => s.themePack)
  const codeTheme = useAppStore((s) => s.codeTheme)

  return (
    <>
      <Section title="Appearance" caption="~/.rennet/client-settings.json">
        <Row label="Scheme" hint="light, dark, or follow the system">
          <Segmented
            options={["light", "dark", "system"]}
            value={scheme}
            onChange={(v) => useAppStore.getState().setScheme(v as typeof scheme)}
          />
        </Row>
      </Section>

      <Section title="Theme Pack" caption="the interface palette">
        <Row label="Theme" stacked>
          <Choice
            options={THEME_PACKS}
            value={themePack}
            onChange={(id) => useAppStore.getState().setThemePack(id)}
          />
        </Row>
      </Section>

      <Section title="Code Theme" caption="syntax highlighting in code and diffs">
        <Row label="Theme" stacked>
          <Choice
            options={CODE_THEMES}
            value={codeTheme}
            onChange={(id) => useAppStore.getState().setCodeTheme(id)}
          />
        </Row>
      </Section>
    </>
  )
}

/** A wrapping row of pill options — live-apply on click. */
function Choice<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { id: T; label: string }[]
  value: T
  onChange: (id: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          onClick={() => onChange(option.id)}
          className={cn(
            "rounded-md border px-2.5 py-1 text-[12px] transition-colors",
            option.id === value
              ? "border-ring bg-secondary text-foreground"
              : "border-border text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function MachinePage({ hosts }: { hosts: HostItem[] }) {
  return (
    <>
      <Section
        title="Environments"
        titleExtra={
          <button
            type="button"
            onClick={() => useAppStore.getState().setAddRemoteOpen(true)}
            className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] font-medium text-foreground/90 transition-colors hover:bg-secondary"
          >
            <Plus className="size-3" aria-hidden="true" />
            Add Environment
          </button>
        }
        caption="~/.rennet/daemon-settings.json on each host"
        bare
      >
        {hosts.map((h) => (
          <EnvironmentCard key={h.id} host={h} />
        ))}
      </Section>
    </>
  )
}

/**
 * How reviews use this host's agents, so it lives on the card with them.
 * The mode switch only exists when there is a choice — two enabled agents;
 * dual runs an independent second seat and reconciles, never merges. The
 * mappings are the Model Council's per-role defaults; an edit becomes a
 * `routing.task.*` override — model and effort only, the harness always
 * follows the model's provider (#89).
 */
function ReviewSettings({ host, enabledIds }: { host: HostItem; enabledIds: string[] }) {
  const [mode, setMode] = React.useState<ReviewMode>("dual")
  const [mappingsOpen, setMappingsOpen] = React.useState(false)

  const detected = (agentTools[host.id] ?? []).length > 0
  if (!detected) return null

  const both = enabledIds.includes("claude") && enabledIds.includes("codex")
  // With one agent the scenario is settled; the switch would be a dead knob.
  const effectiveMode: ReviewMode = both
    ? mode
    : enabledIds.includes("claude")
      ? "claude-only"
      : "codex-only"
  const columns = both ? MODE_COLUMNS : MODE_COLUMNS.filter((c) => c.id === effectiveMode)

  return (
    <div className="flex flex-col border-t border-border pt-1">
      <span className="pt-1 text-[12px] font-medium text-foreground">Review</span>
      {both && (
        <Row
          label="Review Mode"
          hint="dual runs an independent second seat and reconciles — concur or disagree, never a merged answer"
        >
          <Segmented
            options={REVIEW_MODES.map((m) => m.label)}
            value={REVIEW_MODES.find((m) => m.id === mode)?.label ?? "Dual Model"}
            onChange={(label) => {
              const next = REVIEW_MODES.find((m) => m.label === label)
              if (next) setMode(next.id)
            }}
          />
        </Row>
      )}
      <Row
        label="Model Mappings"
        hint={
          enabledIds.length === 0
            ? "enable an agent above to map models"
            : "which model carries each role on this host"
        }
      >
        <Button
          variant="outline"
          size="xs"
          disabled={enabledIds.length === 0}
          onClick={() => setMappingsOpen(true)}
        >
          Edit Mappings
        </Button>
      </Row>
      <MappingsDialog
        mode={effectiveMode}
        columns={columns}
        open={mappingsOpen}
        onOpenChange={setMappingsOpen}
      />
    </div>
  )
}

const MODE_COLUMNS: { id: ReviewMode; key: "dual" | "claudeOnly" | "codexOnly"; label: string }[] = [
  { id: "dual", key: "dual", label: "Dual Model" },
  { id: "claude-only", key: "claudeOnly", label: "Claude Only" },
  { id: "codex-only", key: "codexOnly", label: "Codex Only" },
]

/** Candidate models for a cell: the column's provider set; dual sees both. */
function candidateModels(column: ReviewMode): string[] {
  if (column === "claude-only") return CLAUDE_MODELS
  if (column === "codex-only") return CODEX_MODELS
  return [...CLAUDE_MODELS, ...CODEX_MODELS]
}

/**
 * The council's table, one row per role, only the columns this host's
 * enabled agents make real, the active one highlighted. Cosmetic in the
 * prototype: picks change local state, nothing writes an override.
 */
function MappingsDialog({
  mode,
  columns,
  open,
  onOpenChange,
}: {
  mode: ReviewMode
  columns: typeof MODE_COLUMNS
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [roles, setRoles] = React.useState<ReviewRole[]>(reviewRoles)

  function setModel(roleId: string, key: "dual" | "claudeOnly" | "codexOnly", model: string) {
    setRoles((prev) =>
      prev.map((role) => {
        const current = role[key]
        if (role.id !== roleId || !current) return role
        return { ...role, [key]: { ...current, model } }
      }),
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={columns.length > 1 ? "sm:max-w-[600px]" : "sm:max-w-[420px]"}>
        <DialogHeader>
          <DialogTitle>Model Mappings</DialogTitle>
          <DialogDescription>
            The Model Council’s defaults per role. Availability picks the column; changing a cell
            sets an override for that role — the harness follows the model.
          </DialogDescription>
        </DialogHeader>
        <div
          className="grid items-center gap-x-3 gap-y-0 text-[12px]"
          style={{ gridTemplateColumns: `1.4fr repeat(${columns.length}, 1fr)` }}
        >
          <span />
          {columns.map((column) => (
            <span
              key={column.id}
              className={cn(
                "pb-1.5 font-medium",
                column.id === mode ? "text-foreground" : "text-muted-foreground/60",
              )}
            >
              {column.label}
            </span>
          ))}
          {roles.map((role) => (
            <React.Fragment key={role.id}>
              <span
                className="border-t border-border py-2 pr-2 text-[13px] font-medium text-foreground"
                title={role.hint}
              >
                {role.label}
              </span>
              {columns.map((column) => {
                const assignment = role[column.key]
                return (
                  <span key={column.id} className="border-t border-border py-2">
                    {assignment ? (
                      <ModelCell
                        assignment={assignment}
                        active={column.id === mode}
                        models={candidateModels(column.id)}
                        onChange={(model) => setModel(role.id, column.key, model)}
                      />
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </span>
                )
              })}
            </React.Fragment>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ModelCell({
  assignment,
  active,
  models,
  onChange,
}: {
  assignment: RoleAssignment
  active: boolean
  models: string[]
  onChange: (model: string) => void
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex flex-col items-start rounded-md px-1.5 py-1 text-left font-mono text-[11px] transition-colors hover:bg-secondary",
              active ? "text-foreground" : "text-muted-foreground/70",
            )}
          />
        }
      >
        <span>{assignment.model}</span>
        <span className="text-[10px] text-muted-foreground/60">{assignment.effort}</span>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="start">
        <Command>
          <CommandList>
            <CommandGroup>
              {models.map((model) => (
                <CommandItem
                  key={model}
                  value={model}
                  onSelect={() => {
                    onChange(model)
                    setOpen(false)
                  }}
                  className="font-mono text-[12px]"
                >
                  <Check
                    className={cn("size-3", model === assignment.model ? "opacity-100" : "opacity-0")}
                    aria-hidden="true"
                  />
                  {model}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The machine, not the tooling: which OS it runs, how Rennet reaches it, and
 * what the daemon there reports. An unreachable host says so instead of
 * guessing a version. Local is never removable — it is where Rennet runs.
 */
function EnvironmentCard({ host }: { host: HostItem }) {
  const env: EnvironmentInfo = environments[host.id] ?? { os: "linux", reachable: false }
  const [renaming, setRenaming] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const [removeOpen, setRemoveOpen] = React.useState(false)
  // Cosmetic in the prototype: nothing dials, nothing installs. The pause is
  // texture, and Reconnect settles back to the honest unreachable state.
  const [busy, setBusy] = React.useState<"connecting" | "updating" | null>(null)
  const [updated, setUpdated] = React.useState(false)

  function commitRename() {
    // An emptied name keeps the old one, as the sidebar's rename does.
    useAppStore.getState().renameHost(host.id, draft.trim() || host.label)
    setRenaming(false)
  }

  function pretend(kind: "connecting" | "updating", done?: () => void) {
    setBusy(kind)
    setTimeout(() => {
      setBusy(null)
      done?.()
    }, 1600)
  }

  const version = updated ? LATEST_DAEMON : env.daemonVersion
  const sessions = host.projects.reduce((n, p) => n + p.sessions.length, 0)

  // Which agents this host may use lives on the card, because the review
  // settings below it depend on the answer. Cosmetic: toggles flip fixtures.
  const hostAgents = agentTools[host.id] ?? []
  const [agentEnabled, setAgentEnabled] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(hostAgents.map((t) => [t.id, t.enabled])),
  )
  const toggleAgent = (id: string, next: boolean) =>
    setAgentEnabled((prev) => ({ ...prev, [id]: next }))
  const enabledAgentIds = hostAgents.filter((t) => agentEnabled[t.id]).map((t) => t.id)

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4">
      <div className="flex items-center gap-2">
        <OsIcon os={env.os} />
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename()
              if (event.key === "Escape") {
                event.stopPropagation()
                setRenaming(false)
              }
            }}
            aria-label="Environment name"
            className="min-w-0 flex-1 rounded-sm bg-secondary px-1 py-0.5 text-[14px] font-medium text-foreground outline-none"
          />
        ) : (
          <span className="truncate text-[14px] font-medium text-foreground">{host.label}</span>
        )}
        {env.os === "wsl" && (
          <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            WSL
          </span>
        )}
        {env.address ? (
          <span className="truncate font-mono text-[11px] text-muted-foreground/70">{env.address}</span>
        ) : (
          <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            Local
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Rename ${host.label}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => {
              setDraft(host.label)
              setRenaming(true)
            }}
          >
            <Pencil aria-hidden="true" />
          </Button>
          {/* This Machine is where Rennet runs — there is nothing to remove. */}
          {host.kind !== "local" && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${host.label}`}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setRemoveOpen(true)}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span>
          {busy === "connecting"
            ? "Connecting…"
            : busy === "updating"
              ? "Updating the daemon…"
              : !env.reachable
                ? version
                  ? `Not connected — last seen running Rennet daemon v${version}`
                  : "Not connected — daemon unreachable, version unknown"
                : `Rennet daemon v${version}`}
        </span>
        {!busy && !env.reachable && (
          <Button variant="outline" size="xs" onClick={() => pretend("connecting")}>
            Reconnect
          </Button>
        )}
        {!busy && env.reachable && env.daemonUpdateAvailable && !updated && (
          <Button variant="outline" size="xs" onClick={() => pretend("updating", () => setUpdated(true))}>
            Update Daemon
          </Button>
        )}
      </div>

      {/* GitHub state lives in the Source Control rows below (#483:
          Rennet rides gh — the OAuth-shaped Connect flow is gone). */}
      <SourceControlList host={host} />

      <AgentsList host={host} enabled={agentEnabled} onToggle={toggleAgent} />

      <ReviewSettings host={host} enabledIds={enabledAgentIds} />

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {host.label}?</DialogTitle>
            <DialogDescription>
              {host.projects.length > 0
                ? `This removes the environment, its ${plural(host.projects.length, "project")}${sessions > 0 ? ` and ${plural(sessions, "session")}` : ""}, from Rennet.`
                : "This removes the environment from Rennet."}{" "}
              The machine itself is not touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setRemoveOpen(false)
                useAppStore.getState().removeHost(host.id)
              }}
            >
              Remove Environment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

/**
 * The machine's OS — real platform glyphs (see lib/os-glyphs.ts provenance),
 * inline with currentColor so they follow the theme. WSL is a Windows box,
 * so it takes the Windows mark plus the "WSL" chip beside the name.
 */
function OsIcon({ os }: { os: EnvironmentInfo["os"] }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-3.5 shrink-0 fill-current text-muted-foreground"
      aria-hidden="true"
    >
      <path d={OS_GLYPHS[os]} />
    </svg>
  )
}

/**
 * Official marks, served locally from `public/brand/`. They identify the
 * third-party services a row talks to (nominative use); each remains its
 * owner's trademark. The Git logo is by Jason Long, CC BY 3.0.
 * GitHub's Invertocat has no sanctioned colour form — black or white only, so
 * it scheme-swaps like the sidebar lockup does. The rest read on both schemes.
 */
const TOOL_MARKS: Partial<Record<SourceControlTool["id"], string>> = {
  git: "/brand/git.svg",
  glab: "/brand/gitlab.svg",
  bitbucket: "/brand/bitbucket.svg",
}

function ToolMark({ id }: { id: SourceControlTool["id"] }) {
  const src = TOOL_MARKS[id]
  if (!src) {
    return (
      <>
        {/* biome-ignore lint/performance/noImgElement: static brand SVG, no optimization needed */}
        <img src="/brand/github-mark-white.svg" alt="" aria-hidden="true" className="hidden size-4 dark:block" />
        {/* biome-ignore lint/performance/noImgElement: static brand SVG, no optimization needed */}
        <img src="/brand/github-mark-black.svg" alt="" aria-hidden="true" className="size-4 dark:hidden" />
      </>
    )
  }
  // biome-ignore lint/performance/noImgElement: static brand SVG, no optimization needed
  return <img src={src} alt="" aria-hidden="true" className="size-4" />
}

const SOURCE_CONTROL_STATUS: Record<SourceControlTool["status"], { label: string; chip: string }> = {
  available: { label: "Available", chip: "bg-green-soft text-green" },
  "not-authenticated": { label: "Not Authenticated", chip: "bg-warn-soft text-warn" },
  unreachable: { label: "Unreachable", chip: "bg-warn-soft text-warn" },
  "not-installed": { label: "Not Installed", chip: "bg-secondary text-muted-foreground" },
}

/**
 * What this host can talk to, as detected on the host itself: git, and the
 * CLIs Rennet rides for each forge (#483, #484). Honest state plus the one
 * command that fixes it — no connect ceremony.
 */
function SourceControlList({ host }: { host: HostItem }) {
  const tools = sourceControl[host.id] ?? []
  // Cosmetic in the prototype: the toggle flips fixture state, nothing detects.
  const [enabled, setEnabled] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(tools.map((t) => [t.id, t.enabled])),
  )

  return (
    <div className="flex flex-col border-t border-border pt-1">
      <span className="pt-1 text-[12px] font-medium text-foreground">Source Control</span>
      {tools.length === 0 ? (
        <span className="py-2 text-[12px] text-muted-foreground">
          Connect {host.label} to detect its tooling.
        </span>
      ) : (
        tools.map((tool) => (
          <Row
            key={tool.id}
            label={
              <span className="flex items-center gap-2">
                <ToolMark id={tool.id} />
                {tool.label}
                {tool.version && (
                  <span className="font-mono text-[11px] font-normal text-muted-foreground/70">
                    {tool.version}
                  </span>
                )}
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide",
                    SOURCE_CONTROL_STATUS[tool.status].chip,
                  )}
                >
                  {SOURCE_CONTROL_STATUS[tool.status].label}
                </span>
              </span>
            }
            hint={<CommandCopy text={tool.detail} />}
          >
            <Switch
              checked={enabled[tool.id] ?? tool.enabled}
              onChange={(next) => setEnabled((prev) => ({ ...prev, [tool.id]: next }))}
              label={`Use ${tool.label} on ${host.label}`}
            />
          </Row>
        ))
      )}
    </div>
  )
}

/**
 * The agent marks are official too: OpenAI's blossom has no sanctioned colour
 * form, so it scheme-swaps like the Invertocat; Anthropic's Claude spark ships
 * in its own coral and reads on both schemes. Both from svgl.app, which
 * sources the owners' brand assets; each remains its owner's trademark.
 */
function AgentMark({ id }: { id: AgentTool["id"] }) {
  if (id === "codex") {
    return (
      <>
        {/* biome-ignore lint/performance/noImgElement: static brand SVG, no optimization needed */}
        <img src="/brand/openai-white.svg" alt="" aria-hidden="true" className="hidden size-4 dark:block" />
        {/* biome-ignore lint/performance/noImgElement: static brand SVG, no optimization needed */}
        <img src="/brand/openai-black.svg" alt="" aria-hidden="true" className="size-4 dark:hidden" />
      </>
    )
  }
  // biome-ignore lint/performance/noImgElement: static brand SVG, no optimization needed
  return <img src="/brand/claude.svg" alt="" aria-hidden="true" className="size-4" />
}

/**
 * The coding agents this host can run, detected the same way the forge CLIs
 * are: the harness's own version line, honest state, and the one command that
 * fixes it. The toggle rules an agent out of reviews on this host without
 * uninstalling anything.
 */
function AgentsList({
  host,
  enabled,
  onToggle,
}: {
  host: HostItem
  enabled: Record<string, boolean>
  onToggle: (id: string, next: boolean) => void
}) {
  const tools = agentTools[host.id] ?? []

  return (
    <div className="flex flex-col border-t border-border pt-1">
      <span className="pt-1 text-[12px] font-medium text-foreground">Agents</span>
      {tools.length === 0 ? (
        <span className="py-2 text-[12px] text-muted-foreground">
          Connect {host.label} to detect its agents.
        </span>
      ) : (
        tools.map((tool) => (
          <Row
            key={tool.id}
            label={
              <span className="flex items-center gap-2">
                <AgentMark id={tool.id} />
                {tool.label}
                {tool.version && (
                  <span className="font-mono text-[11px] font-normal text-muted-foreground/70">
                    {tool.version}
                  </span>
                )}
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide",
                    SOURCE_CONTROL_STATUS[tool.status].chip,
                  )}
                >
                  {SOURCE_CONTROL_STATUS[tool.status].label}
                </span>
              </span>
            }
            hint={<CommandCopy text={tool.detail} />}
          >
            <Switch
              checked={enabled[tool.id] ?? tool.enabled}
              onChange={(next) => onToggle(tool.id, next)}
              label={`Use ${tool.label} on ${host.label}`}
            />
          </Row>
        ))
      )}
    </div>
  )
}

/** Settings copy renders `backticked` commands as code, as Add Remote does. */
function CommandCopy({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`]+)`/).map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="rounded bg-secondary px-1 font-mono">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  )
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        checked ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "size-3 rounded-full transition-transform",
          checked ? "translate-x-3 bg-primary-foreground" : "translate-x-0 bg-muted-foreground/60",
        )}
      />
    </button>
  )
}

function ShortcutsPage() {
  const [filter, setFilter] = React.useState("")
  const shown = keyCommands.filter((c) => c.label.toLowerCase().includes(filter.trim().toLowerCase()))

  return (
    <Section title="Keyboard Shortcuts" caption="~/.rennet/client-settings.json">
      <div className="py-2.5">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            // Esc clears the filter before it can close settings.
            if (event.key === "Escape" && filter) {
              event.stopPropagation()
              setFilter("")
            }
          }}
          placeholder="Filter commands…"
          className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
        />
      </div>
      <div className="flex flex-col py-1.5">
        {shown.map((command) => (
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
        {shown.length === 0 && (
          <span className="px-2 py-2 text-[13px] text-muted-foreground">
            No commands match “{filter.trim()}”.
          </span>
        )}
      </div>
    </Section>
  )
}

function ProjectsPage({
  hosts,
  host,
  project,
  onProjectChange,
  onRenameProject,
  onSetProjectIcon,
}: {
  hosts: HostItem[]
  host: HostItem
  project: ProjectItem
  onProjectChange: (project: ProjectItem) => void
  onRenameProject: (projectId: string, name: string) => void
  onSetProjectIcon: (projectId: string, icon: ProjectIconName) => void
}) {
  const repo = projectSettings[project.id] ?? {
    visibility: { value: "local" as const, layer: "builtin" as const },
    promoted: false,
    locus: { value: host.label, layer: "detected" as const },
    guidance: [],
  }
  const [guidanceByProject, setGuidanceByProject] = React.useState<Record<string, GuidanceRule[]>>(
    () => Object.fromEntries(Object.entries(projectSettings).map(([id, s]) => [id, s.guidance])),
  )
  const guidance = guidanceByProject[project.id] ?? []

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-medium text-foreground">Project</span>
        <ProjectPicker hosts={hosts} value={project} onChange={onProjectChange} />
      </div>

      <IdentitySection
        project={project}
        onRenameProject={onRenameProject}
        onSetProjectIcon={onSetProjectIcon}
      />

      <WorktreeSection project={project} />

      <Section title="Repository" caption={`.rennet/ in ${project.name}`}>
        <Row label="Review Context" hint="whether .rennet is visible to git">
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
      </Section>

      <Section title="Guidance" caption={`.rennet/ in ${project.name}`}>
        <Row label="Rules" hint="repo rules the review agents read" stacked>
          <GuidanceList
            rules={guidance}
            onChange={(rules) =>
              setGuidanceByProject((prev) => ({ ...prev, [project.id]: rules }))
            }
          />
        </Row>
      </Section>
    </>
  )
}

function IdentitySection({
  project,
  onRenameProject,
  onSetProjectIcon,
}: {
  project: ProjectItem
  onRenameProject: (projectId: string, name: string) => void
  onSetProjectIcon: (projectId: string, icon: ProjectIconName) => void
}) {
  const selectedIcon = project.icon ?? "layers"
  const renamed = project.name !== project.repo

  return (
    <Section title="Identity" caption="~/.rennet/client-settings.json">
      <Row label="Name" hint={`defaults to ${project.repo}`}>
        {renamed && (
          <button
            type="button"
            onClick={() => onRenameProject(project.id, project.repo)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <RotateCcw className="size-3" aria-hidden="true" />
            Reset
          </button>
        )}
        <input
          value={project.name}
          onChange={(event) => onRenameProject(project.id, event.target.value)}
          onBlur={(event) => {
            if (!event.target.value.trim()) onRenameProject(project.id, project.repo)
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation()
              event.currentTarget.blur()
            }
          }}
          aria-label="Project name"
          placeholder={project.repo}
          className="w-56 rounded-md border border-border bg-card px-2 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
        />
      </Row>
      <Row label="Icon" hint="shown next to the project in the sidebar" stacked>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Project icon">
          {(Object.keys(PROJECT_ICONS) as ProjectIconName[]).map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={name === selectedIcon}
              aria-label={name}
              title={name}
              onClick={() => onSetProjectIcon(project.id, name)}
              className={cn(
                "flex size-8 items-center justify-center rounded-md border transition-colors",
                name === selectedIcon
                  ? "border-ring bg-secondary text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
              )}
            >
              <ProjectIcon icon={name} className="size-4" />
            </button>
          ))}
        </div>
      </Row>
    </Section>
  )
}

function WorktreeSection({ project }: { project: ProjectItem }) {
  // Prototype-local state; per-project overrides over the client defaults.
  const [byProject, setByProject] = React.useState<Record<string, WorktreeSettings>>({})
  const settings = byProject[project.id] ?? defaultWorktrees
  const patch = (next: Partial<WorktreeSettings>) =>
    setByProject((prev) => ({ ...prev, [project.id]: { ...settings, ...next } }))

  const root = settings.root.replace(/\/+$/, "")
  const preview = `${root}/${previewWorktreeName(settings.pattern, project.name)}`

  const stopEscape = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation()
      ;(event.currentTarget as HTMLElement).blur()
    }
  }

  return (
    <Section title="Worktrees" caption="~/.rennet/client-settings.json">
      <Row label="Location" hint="new worktrees for this project are created here" stacked>
        <input
          value={settings.root}
          onChange={(event) => patch({ root: event.target.value })}
          onKeyDown={stopEscape}
          aria-label="Worktree location"
          spellCheck={false}
          className="w-full rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
        />
      </Row>
      <Row label="Naming" hint="how each worktree folder is named" stacked>
        <input
          value={settings.pattern}
          onChange={(event) => patch({ pattern: event.target.value })}
          onKeyDown={stopEscape}
          aria-label="Worktree naming pattern"
          spellCheck={false}
          className="w-full rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none"
        />
        <div className="flex flex-wrap items-center gap-1">
          {worktreeTokens.map((t) => (
            <button
              key={t.token}
              type="button"
              onClick={() => patch({ pattern: settings.pattern + t.token })}
              title={`Insert ${t.token}`}
              className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <span className="font-mono">{t.token}</span>
              <span className="text-muted-foreground/60">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="flex items-baseline gap-2 rounded-md bg-secondary/40 px-2 py-1.5">
          <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground/70">
            Preview
          </span>
          <span className="truncate font-mono text-[12px] text-foreground/90">{preview}</span>
        </div>
      </Row>
    </Section>
  )
}

function Section({
  title,
  titleExtra,
  caption,
  bare,
  children,
}: {
  title: string
  titleExtra?: React.ReactNode
  caption: string
  /** Children bring their own surface (the environment cards) — no box. */
  bare?: boolean
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
      <div
        className={cn(
          "flex flex-col",
          bare ? "gap-3 pt-1" : "divide-y divide-border rounded-md border border-border px-3",
        )}
      >
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
  label: React.ReactNode
  hint?: React.ReactNode
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
  medium: "bg-warn-soft text-warn",
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
          Add Rule
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
            <ProjectIcon icon={value.icon} className="size-3.5 text-muted-foreground" />
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
                    <ProjectIcon icon={project.icon} className="size-3.5 text-muted-foreground" />
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
