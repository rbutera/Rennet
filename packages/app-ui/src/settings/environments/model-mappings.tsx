import {
  Button,
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rennet/ui";
import { Check, RotateCcw } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { Icon } from "../../components/icon";
import { CLAUDE_MODELS, CODEX_MODELS } from "../assets/model-council";
import { Row } from "../atoms";
import {
  type ReviewRole,
  type RoleAssignment,
  type SettingsHost,
  useSettingsProjection,
} from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// The Review section + Model Mappings dialog (C10 §5.2–5.4, claims 614–625).
// How reviews use this host's agents lives on the card WITH them, because the
// answer depends on which harnesses are enabled (§5.1).
//
//   • Review section (`ReviewSettings`) — absent entirely when no agent was
//     detected; its "Edit Mappings" button is inert until at least one agent is
//     ENABLED, and its hint says so.
//   • MappingsDialog — the council's table with the review mode built into the
//     column headers: two columns (Dual Harness / Single Harness) whose HEADERS
//     ARE the mode switch. The selected header carries the green tick; the other
//     column dims and locks. There is NO separate Review Mode row. Dual is
//     unavailable until BOTH agents are enabled (hovering anywhere in it says
//     which one unlocks it); losing the second agent settles Single whatever was
//     clicked; Single auto-detects its provider, Claude first, and names it.
//   • Each role names its model + effort; an editable cell opens a short unsearched
//     picker (a host offers a handful of models, all visible at once — a filter over a
//     list you can read is chrome, and it takes the focus the arrow keys want, so the
//     spike has none); a role that does not run in a mode renders an em dash (never a fake
//     assignment); a cell whose PROVENANCE says an override won carries a chip, and
//     a role with any override gains "Reset to default" (C16, #485).
//
// Every assignment edit flows through the `setRoleAssignment` projection seam — live
// against `settings.setRoleAssignment` (C16), never a local table copy, never
// `bridge.invoke`. Each edit and each Reset touches exactly ONE (role, scenario) cell;
// Reset clears the override with `null` so the council table answers again. The mode is
// dialog-local view state (there is no persisted review-mode command yet; the seam owns
// the assignments, not the chosen mode).
// ─────────────────────────────────────────────────────────────────────────────

type HarnessMode = "dual" | "single";
type Scenario = "dual" | "claudeOnly" | "codexOnly";

const SCENARIOS = ["dual", "claudeOnly", "codexOnly"] as const;

/** Which columns of a role carry an override. Read off the cell's own provenance
 *  (C16) — never a comparison against a copied default table, which would drift. */
function overriddenScenarios(role: ReviewRole): readonly Scenario[] {
  return SCENARIOS.filter((key) => role[key]?.layer === "override");
}

/** The Review block on a host card. Returns null unless an agent was detected. */
export function ReviewSettings({
  host,
  enabledIds,
}: {
  readonly host: SettingsHost;
  readonly enabledIds: readonly string[];
}) {
  const projection = useSettingsProjection();
  const [mappingsOpen, setMappingsOpen] = useState(false);

  const detected = (projection.agentsByHost[host.id] ?? []).length > 0;
  if (!detected) return null;

  const noneEnabled = enabledIds.length === 0;

  return (
    <div className="flex flex-col border-t border-line pt-1">
      <span className="pt-1 text-xs font-medium text-ink">Review</span>
      <Row
        label="Model Mappings"
        hint={
          noneEnabled
            ? "enable an agent above to map models"
            : "review mode and which model carries each role on this host"
        }
      >
        <Button
          variant="outline"
          size="xs"
          disabled={noneEnabled}
          onClick={() => setMappingsOpen(true)}
        >
          Edit Mappings
        </Button>
      </Row>
      <MappingsDialog enabledIds={enabledIds} open={mappingsOpen} onOpenChange={setMappingsOpen} />
    </div>
  );
}

function MappingsDialog({
  enabledIds,
  open,
  onOpenChange,
}: {
  readonly enabledIds: readonly string[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const projection = useSettingsProjection();
  // HONEST-PRESENT AT THE SOURCE (C16, #485): the served value is the ONLY value. The
  // dispatch handler resolves the council tables even with no settings dep, so a read
  // always carries the eight roles — the client never needs a local table to fall back
  // to, and must not have one. A client-side copy of the tables cannot be pinned to
  // core, so it can only drift into rendering a confident wrong model (it had six such
  // cells). An empty projection renders empty, which is honest about a read in flight.
  const roles = projection.reviewRoles;

  const claudeOn = enabledIds.includes("claude");
  const codexOn = enabledIds.includes("codex");
  const both = claudeOn && codexOn;
  const singleKey: "claudeOnly" | "codexOnly" = claudeOn ? "claudeOnly" : "codexOnly";
  const singleProvider = claudeOn ? "Claude" : "Codex";
  const missingProvider = claudeOn ? "Codex" : "Claude";
  const singleModels = claudeOn ? CLAUDE_MODELS : CODEX_MODELS;

  const [mode, setMode] = useState<HarnessMode>(both ? "dual" : "single");
  // Losing the second agent settles the question, whatever header was clicked.
  const effective: HarnessMode = both ? mode : "single";

  function setModel(roleId: string, key: Scenario, model: string) {
    const current = roles.find((r) => r.id === roleId)?.[key];
    if (!current) return;
    // Model + effort only: `layer` is the resolver's verdict on the write, not an input.
    projection.setRoleAssignment(roleId, key, { model, effort: current.effort });
  }

  // Reset CLEARS the override (`null`) rather than writing a copy of the default back:
  // the council table is the answer, and only the columns actually overridden move.
  function resetRole(role: ReviewRole) {
    for (const key of overriddenScenarios(role)) {
      projection.setRoleAssignment(role.id, key, null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Model Mappings</DialogTitle>
          <DialogDescription>
            The Model Council&rsquo;s defaults per role. Click a column header to set the review
            mode; changing a cell sets an override for that role — the harness follows the model.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[1.4fr_1fr_1fr] items-center gap-x-3 gap-y-0 text-xs">
          <span />
          <DualUnavailableHint active={!both} missing={missingProvider}>
            <ModeHeader
              label="Dual Harness"
              sub="one seat per provider"
              selected={effective === "dual"}
              available={both}
              onSelect={() => setMode("dual")}
            />
          </DualUnavailableHint>
          <ModeHeader
            label="Single Harness"
            sub={both ? `falls to ${singleProvider}` : singleProvider}
            selected={effective === "single"}
            available
            onSelect={() => setMode("single")}
          />
          {roles.map((role) => {
            const cells: {
              readonly key: Scenario;
              readonly editable: boolean;
              readonly unavailable?: boolean;
              readonly models: readonly string[];
            }[] = [
              {
                key: "dual",
                editable: both && effective === "dual",
                unavailable: !both,
                models: [...CLAUDE_MODELS, ...CODEX_MODELS],
              },
              {
                key: singleKey,
                editable: effective === "single",
                models: singleModels,
              },
            ];
            return (
              <Fragment key={role.id}>
                <span className="flex flex-col items-start border-t border-line py-2 pr-2">
                  <span className="text-xs font-medium text-ink" title={role.hint}>
                    {role.label}
                  </span>
                  {overriddenScenarios(role).length > 0 && (
                    <button
                      type="button"
                      onClick={() => resetRole(role)}
                      className="flex items-center gap-1 text-2xs text-ink-soft transition-colors hover:text-ink"
                    >
                      <Icon icon={RotateCcw} className="size-2.5" />
                      Reset to default
                    </button>
                  )}
                </span>
                {cells.map((cell) => {
                  const assignment = role[cell.key];
                  const body = assignment ? (
                    <ModelCell
                      assignment={assignment}
                      editable={cell.editable}
                      models={cell.models}
                      label={`${role.label} model`}
                      onChange={(model) => setModel(role.id, cell.key, model)}
                    />
                  ) : (
                    <span className="text-ink-faint">—</span>
                  );
                  return (
                    <span
                      key={cell.key}
                      className={cn("border-t border-line py-2", !cell.editable && "opacity-40")}
                    >
                      {cell.unavailable ? (
                        <DualUnavailableHint active missing={missingProvider}>
                          {body}
                        </DualUnavailableHint>
                      ) : (
                        body
                      )}
                    </span>
                  );
                })}
              </Fragment>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A column header that is also the mode switch. The green tick is the state. */
function ModeHeader({
  label,
  sub,
  selected,
  available,
  onSelect,
}: {
  readonly label: string;
  readonly sub?: string;
  readonly selected: boolean;
  readonly available: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!available}
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex items-start gap-1.5 pb-1.5 text-left font-medium transition-colors",
        selected
          ? "text-ink"
          : available
            ? "text-ink-soft hover:text-ink"
            : "cursor-not-allowed text-ink-faint",
      )}
    >
      <span className="flex flex-col">
        {label}
        {sub && <span className="text-10 font-normal text-ink-faint">{sub}</span>}
      </span>
      {selected && <Icon icon={Check} strokeWidth={3} className="size-4 shrink-0 text-green" />}
    </button>
  );
}

/**
 * The hover tip that says what would unlock Dual. Wraps every cell of the
 * unavailable Dual column, so hovering anywhere in it explains the lock.
 * Hand-rolled (the kit has no tooltip primitive, R55).
 */
function DualUnavailableHint({
  active,
  missing,
  children,
}: {
  readonly active: boolean;
  readonly missing: string;
  readonly children: ReactNode;
}) {
  if (!active) return <>{children}</>;
  return (
    <span className="group relative block">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute top-full left-1/2 z-10 hidden w-max -translate-x-1/2 rounded-md border border-line bg-popover px-2 py-1 text-2xs text-popover-foreground shadow-overlay group-hover:block"
      >
        Enable {missing} to turn on Dual Harness (Recommended)
      </span>
    </span>
  );
}

function ModelCell({
  assignment,
  editable,
  models,
  label,
  onChange,
}: {
  readonly assignment: RoleAssignment;
  readonly editable: boolean;
  readonly models: readonly string[];
  readonly label: string;
  readonly onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);

  // The provenance chip (C16, #485): a cell only carries it when a routing override
  // actually won. An unchipped cell IS the council table — the chip is the whole
  // "where did this value come from" answer, so it is never rendered speculatively.
  const display = (
    <>
      <span className="flex items-center gap-1">
        {assignment.model}
        {assignment.layer === "override" && (
          <span
            title="Overridden — the council default was replaced for this scenario"
            className="rounded-sm border border-line px-1 font-sans text-2xs text-ink-soft"
          >
            Overridden
          </span>
        )}
      </span>
      <span className="text-2xs text-ink-faint">{assignment.effort}</span>
    </>
  );

  if (!editable) {
    return (
      <span className="flex flex-col items-start px-1.5 py-1 font-mono text-2xs text-ink-soft">
        {display}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className="flex flex-col items-start rounded-md px-1.5 py-1 text-left font-mono text-2xs text-ink transition-colors hover:bg-raised"
          />
        }
      >
        {display}
      </PopoverTrigger>
      {/* No search box. A host offers a handful of models, all of them on screen at once,
          so a filter over a list you can already read is chrome — and it steals the focus
          the arrow keys want. The popover narrows to the width the model names need. */}
      <PopoverContent className="w-44 p-1" align="start">
        <Command>
          <CommandList>
            <CommandGroup>
              {models.map((model) => (
                <CommandItem
                  key={model}
                  value={model}
                  // The tick is the kit's own trailing column now (CommandItem renders it
                  // off `data-checked`), so the row no longer carries a second one.
                  data-checked={model === assignment.model}
                  onSelect={() => {
                    onChange(model);
                    setOpen(false);
                  }}
                  className="font-mono text-xs"
                >
                  {model}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
