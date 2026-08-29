import type { HostElement, LensBoard, SpecDelta } from "@rennet/protocol";
import { cn } from "@rennet/ui";
import { ArrowDown } from "lucide-react";
import { Icon } from "../components/icon";
import {
  DesignSectionMetadata,
  followBoardAnchor,
  SourceChips,
  SpecDeltaBadge,
} from "./design-meta";
import { useBoardElementIndex } from "./kinds/element-context";
import { BoardChildren, BoardElement } from "./kinds/renderers";
import type { ElementOf } from "./registry";

type SectionElement = ElementOf<"section">;
type RequirementElement = ElementOf<"requirement">;

interface CapabilitySummary {
  readonly section: SectionElement;
  readonly slug: string;
  readonly requirements: number;
  readonly scenarios: number;
  readonly deltas: readonly SpecDelta[];
  readonly delta?: SpecDelta;
}

interface TaskGroupProgress {
  readonly id: string;
  readonly label: string;
  readonly done: number;
  readonly total: number;
}

function normalizedLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveChildren(
  ids: readonly string[],
  index: ReadonlyMap<string, HostElement>,
): HostElement[] {
  return ids.flatMap((id) => {
    const element = index.get(id);
    return element ? [element] : [];
  });
}

interface PositionedRequirement {
  readonly requirement: RequirementElement;
  readonly sectionAncestors: readonly SectionElement[];
}

function topologyRequirements(
  board: LensBoard,
  index: ReadonlyMap<string, HostElement>,
): PositionedRequirement[] {
  const requirements: PositionedRequirement[] = [];
  const seen = new Set<string>();
  const visit = (section: SectionElement, ancestors: readonly SectionElement[]) => {
    if (seen.has(section.id)) return;
    seen.add(section.id);
    const sectionAncestors = [...ancestors, section];
    for (const childId of section.data.children) {
      if (seen.has(childId)) continue;
      const child = index.get(childId);
      if (child?.kind === "requirement") {
        seen.add(child.id);
        requirements.push({ requirement: child, sectionAncestors });
      } else if (child?.kind === "section") {
        visit(child, sectionAncestors);
      }
    }
  };
  for (const { ref } of board.sections) {
    const section = index.get(ref);
    if (section?.kind === "section") visit(section, []);
  }
  return requirements;
}

function orderedRequirementDeltas(requirements: readonly PositionedRequirement[]): SpecDelta[] {
  return [
    ...new Set(
      requirements.flatMap(({ requirement }) =>
        requirement.data.spec_delta === undefined ? [] : [requirement.data.spec_delta],
      ),
    ),
  ];
}

function sectionMatchesCapability(section: SectionElement, capability: string): boolean {
  const title = normalizedLabel(section.data.title);
  const identity = normalizedLabel(capability);
  return (
    title === identity ||
    title === `${identity} requirements` ||
    (identity.startsWith("story ") && title.startsWith(`${identity} `))
  );
}

function capabilitySection(
  capability: string,
  requirements: readonly PositionedRequirement[],
): SectionElement | undefined {
  const first = requirements[0]?.sectionAncestors;
  if (first === undefined) return undefined;
  let nearestCommon: SectionElement | undefined;
  for (let index = first.length - 1; index >= 0; index -= 1) {
    const candidate = first[index];
    if (
      candidate !== undefined &&
      requirements.every(({ sectionAncestors }) =>
        sectionAncestors.some((section) => section.id === candidate.id),
      )
    ) {
      nearestCommon ??= candidate;
      if (sectionMatchesCapability(candidate, capability)) return candidate;
    }
  }
  return nearestCommon;
}

function capabilitySummaries(board: LensBoard): CapabilitySummary[] {
  const index = new Map(board.elements.map((element) => [element.id, element]));
  const grouped = new Map<string, PositionedRequirement[]>();
  for (const positioned of topologyRequirements(board, index)) {
    const capability = positioned.requirement.data.capability;
    if (capability === undefined || capability.length === 0) continue;
    const requirements = grouped.get(capability) ?? [];
    requirements.push(positioned);
    grouped.set(capability, requirements);
  }
  return [...grouped].flatMap(([slug, requirements]) => {
    const section = capabilitySection(slug, requirements);
    if (section === undefined) return [];
    const scenarioIds = new Set(
      requirements.flatMap(({ requirement }) => requirement.data.scenarios ?? []),
    );
    const deltas = orderedRequirementDeltas(requirements);
    const delta = deltas.length === 1 ? deltas[0] : undefined;
    return [
      {
        section,
        slug,
        requirements: requirements.length,
        scenarios: scenarioIds.size,
        deltas,
        ...(delta === undefined ? {} : { delta }),
      },
    ];
  });
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

/** The Design header's capability roll-up, derived from canonical requirement sections. */
export function DesignCapabilityGrid({ board }: { readonly board: LensBoard }) {
  const capabilities = capabilitySummaries(board);
  if (capabilities.length === 0) return null;
  return (
    <nav data-kind="capability-grid" aria-label="Design capabilities" className="mb-8">
      <p className="mb-2 font-medium text-xs text-foreground">Capabilities</p>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {capabilities.map((capability) => (
          <a
            key={capability.section.id}
            href={`#${capability.section.id}`}
            data-capability={capability.slug}
            {...(capability.delta ? { "data-spec-delta": capability.delta } : {})}
            {...(capability.deltas.length > 0
              ? { "data-spec-deltas": capability.deltas.join(" ") }
              : {})}
            aria-label={`Jump to ${capability.slug}`}
            onClick={(event) => followBoardAnchor(event, capability.section.id)}
            className={cn(
              "group flex min-w-0 flex-col gap-1 rounded-surface border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-raised focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent-line",
              capability.deltas.includes("added") && "border-l-green-line",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono font-medium text-sm text-foreground">
                {capability.slug}
              </span>
              {capability.deltas.map((delta) => (
                <SpecDeltaBadge key={delta} delta={delta} />
              ))}
              <Icon
                icon={ArrowDown}
                className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-y-0.5"
              />
            </span>
            <span className="text-xs text-muted-foreground">
              {countLabel(capability.requirements, "requirement")} ·{" "}
              {countLabel(capability.scenarios, "scenario")}
            </span>
          </a>
        ))}
      </div>
    </nav>
  );
}

function explicitDesignRole(element: HostElement): string | undefined {
  const role = element.data.design_role;
  return typeof role === "string" ? normalizedLabel(role) : undefined;
}

function rowTag(element: HostElement): string {
  const tag = element.data.tag;
  return typeof tag === "string" && tag.length > 0 ? tag : element.id;
}

function ProposalSpine({
  changes,
  impact,
  whatChangesSource,
  impactSource,
}: {
  readonly changes: readonly HostElement[];
  readonly impact: readonly HostElement[];
  readonly whatChangesSource?: SectionElement;
  readonly impactSource?: SectionElement;
}) {
  if (changes.length === 0 && impact.length === 0) return null;
  return (
    <div
      data-kind="design-proposal-spine"
      className={cn("grid gap-4", impact.length > 0 && "md:grid-cols-[3fr_2fr]")}
    >
      {changes.length > 0 ? (
        <div
          data-kind="design-what-changes"
          data-element-id={whatChangesSource?.id}
          className="flex min-w-0 flex-col"
        >
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <p className="font-medium text-xs text-foreground">What Changes</p>
            <SourceChips sources={whatChangesSource?.data.sources ?? []} />
          </div>
          <div className="flex flex-col divide-y divide-line/60">
            {changes.map((element) => (
              <div
                key={element.id}
                data-kind="design-change-row"
                className="flex items-start gap-2.5 py-2"
              >
                <span className="mt-0.5 shrink-0 rounded-chip border border-line bg-surface px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                  {rowTag(element)}
                </span>
                <div className="min-w-0 flex-1">
                  <BoardElement element={element} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {impact.length > 0 ? (
        <aside
          data-kind="design-impact"
          data-element-id={impactSource?.id}
          className="flex min-w-0 flex-col"
        >
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <p className="font-medium text-xs text-foreground">Impact</p>
            <SourceChips sources={impactSource?.data.sources ?? []} />
          </div>
          <div className="flex flex-col gap-2 rounded-surface border border-line bg-raised px-3 py-2.5">
            {impact.map((element) => (
              <BoardElement key={element.id} element={element} />
            ))}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function checkboxCount(markdown: string): { readonly done: number; readonly total: number } {
  const marks = [...markdown.matchAll(/(?:^|\n)\s*(?:[-*+]\s*)?\[([ xX])\](?=\s|$)/g)];
  return {
    done: marks.filter((match) => match[1]?.toLowerCase() === "x").length,
    total: marks.length,
  };
}

function taskCountForElement(
  element: HostElement,
  index: ReadonlyMap<string, HostElement>,
  seen: Set<string>,
): { readonly done: number; readonly total: number } {
  if (seen.has(element.id)) return { done: 0, total: 0 };
  seen.add(element.id);
  if (element.kind === "section") {
    return resolveChildren(element.data.children, index).reduce(
      (total, child) => {
        const count = taskCountForElement(child, index, seen);
        return { done: total.done + count.done, total: total.total + count.total };
      },
      { done: 0, total: 0 },
    );
  }
  if (element.kind === "prose") return checkboxCount(element.data.markdown);
  if (element.kind === "callout") return checkboxCount(element.data.body);
  const done = element.data.done;
  return typeof done === "boolean" ? { done: done ? 1 : 0, total: 1 } : { done: 0, total: 0 };
}

type HostTaskProgress =
  | {
      readonly kind: "source";
      readonly format: string;
      readonly role: string;
      readonly layout: "grouped";
    }
  | {
      readonly kind: "source";
      readonly format: string;
      readonly role: string;
      readonly layout: "ungrouped";
      readonly done: number;
      readonly total: number;
    }
  | { readonly kind: "group"; readonly state: "static" | "complete" | "incomplete" };

function hostTaskProgress(element: SectionElement): HostTaskProgress | undefined {
  const value = (element.data as { task_progress?: unknown }).task_progress;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const projection = value as Record<string, unknown>;
  if (
    projection.kind === "source" &&
    typeof projection.format === "string" &&
    typeof projection.role === "string" &&
    projection.layout === "grouped"
  ) {
    return {
      kind: "source",
      format: projection.format,
      role: projection.role,
      layout: projection.layout,
    };
  }
  if (
    projection.kind === "source" &&
    typeof projection.format === "string" &&
    typeof projection.role === "string" &&
    projection.layout === "ungrouped" &&
    typeof projection.done === "number" &&
    typeof projection.total === "number"
  ) {
    return {
      kind: "source",
      format: projection.format,
      role: projection.role,
      layout: projection.layout,
      done: projection.done,
      total: projection.total,
    };
  }
  if (
    projection.kind === "group" &&
    (projection.state === "static" ||
      projection.state === "complete" ||
      projection.state === "incomplete")
  ) {
    return { kind: "group", state: projection.state };
  }
  return undefined;
}

function projectedTaskGroups(
  section: SectionElement,
  index: ReadonlyMap<string, HostElement>,
): SectionElement[] {
  const groups: SectionElement[] = [];
  const seen = new Set<string>();
  const visit = (ids: readonly string[]) => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const child = index.get(id);
      if (child?.kind !== "section") continue;
      const projection = hostTaskProgress(child);
      if (projection?.kind === "source") continue;
      if (projection?.kind === "group") groups.push(child);
      visit(child.data.children);
    }
  };
  visit(section.data.children);
  return groups;
}

function progressForSection(
  section: SectionElement,
  index: ReadonlyMap<string, HostElement>,
): TaskGroupProgress[] {
  const source = hostTaskProgress(section);
  if (source?.kind !== "source") return [];
  const nestedGroups = projectedTaskGroups(section, index);
  if (nestedGroups.length === 0 && source.layout === "ungrouped") {
    return source.total > 0
      ? [{ id: section.id, label: section.data.title, done: source.done, total: source.total }]
      : [];
  }
  const groups = nestedGroups;
  return groups.flatMap((group) => {
    const projected = hostTaskProgress(group);
    const count =
      projected?.kind === "group" && projected.state !== "static"
        ? { done: projected.state === "complete" ? 1 : 0, total: 1 }
        : taskCountForElement(group, index, new Set());
    return count.total > 0
      ? [{ id: group.id, label: group.data.title, done: count.done, total: count.total }]
      : [];
  });
}

function TaskProgress({ groups }: { readonly groups: readonly TaskGroupProgress[] }) {
  if (groups.length === 0) return null;
  const done = groups.reduce((sum, group) => sum + group.done, 0);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  return (
    <div data-kind="task-progress" className="flex flex-col">
      <p className="mb-2 font-medium text-xs text-foreground">
        Tasks · {done}/{total}
      </p>
      <div className="flex flex-col divide-y divide-line/60 rounded-surface border border-line px-3">
        {groups.map((group) => {
          const complete = group.done === group.total;
          const percent = Math.round((group.done / group.total) * 100);
          return (
            <div
              key={group.id}
              data-kind="task-progress-group"
              data-task-group={group.id}
              className="flex flex-wrap items-center gap-3 py-2"
            >
              <span className="min-w-48 flex-1 text-sm text-foreground/90">{group.label}</span>
              <span
                role="progressbar"
                aria-label={`${group.label}: ${group.done} of ${group.total} tasks complete`}
                aria-valuenow={group.done}
                aria-valuemin={0}
                aria-valuemax={group.total}
                aria-valuetext={`${group.done} of ${group.total} tasks complete`}
                className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-raised"
              >
                <span
                  className={cn(
                    "block h-full rounded-full",
                    complete ? "bg-green" : "bg-foreground/40",
                  )}
                  style={{ width: `${percent}%` }}
                />
              </span>
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {group.done}/{group.total}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Design-only composition over canonical sections. Other lenses keep BoardChildren. */
export function DesignSectionBody({ section }: { readonly section: SectionElement }) {
  const index = useBoardElementIndex();
  const direct = resolveChildren(section.data.children, index);
  const whatChangesSection = direct.find(
    (element): element is SectionElement =>
      element.kind === "section" && normalizedLabel(element.data.title) === "what changes",
  );
  const impactSection = direct.find(
    (element): element is SectionElement =>
      element.kind === "section" && normalizedLabel(element.data.title) === "impact",
  );
  const directChanges = direct.filter((element) => explicitDesignRole(element) === "what change");
  const directImpact = direct.filter((element) => explicitDesignRole(element) === "impact");
  const changes = whatChangesSection
    ? resolveChildren(whatChangesSection.data.children, index)
    : directChanges;
  const impact = impactSection ? resolveChildren(impactSection.data.children, index) : directImpact;
  const consumed = new Set([
    ...(whatChangesSection ? [whatChangesSection.id] : directChanges.map(({ id }) => id)),
    ...(impactSection ? [impactSection.id] : directImpact.map(({ id }) => id)),
  ]);
  const remaining = section.data.children.filter((id) => !consumed.has(id));
  const taskGroups = progressForSection(section, index);

  return (
    <>
      <DesignSectionMetadata taskManifest={section.data.task_manifest} />
      {taskGroups.length > 0 ? <TaskProgress groups={taskGroups} /> : null}
      <BoardChildren ids={remaining} />
      <ProposalSpine
        changes={changes}
        impact={impact}
        whatChangesSource={whatChangesSection}
        impactSource={impactSection}
      />
    </>
  );
}
