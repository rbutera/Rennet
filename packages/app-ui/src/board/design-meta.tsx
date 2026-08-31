import type { SourceRef, SpecDelta } from "@rennet/protocol";
import { COLLAPSE_MS, cn } from "@rennet/ui";
import { FileText } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Icon } from "../components/icon";
import { useMutation } from "../data";
import { useBoardReviewId } from "./kinds/element-context";

// Soft fill, no border (prototype `lens-board.tsx:678-690`). Gold is the reserve accent, so
// "modified" reads neutral — a spec that moved is not an event worth an accent. "renamed"
// has no prototype counterpart and takes the same neutral; its word carries the difference.
const SPEC_DELTA_TONE: Readonly<Record<SpecDelta, string>> = {
  added: "bg-green-soft text-green",
  modified: "bg-secondary text-muted-foreground",
  removed: "bg-destructive/15 text-destructive",
  renamed: "bg-secondary text-muted-foreground",
};

export function SpecDeltaBadge({ delta }: { readonly delta: SpecDelta }) {
  return (
    <span
      data-kind="spec-delta"
      data-spec-delta={delta}
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 font-semibold text-10 uppercase tracking-wide",
        SPEC_DELTA_TONE[delta],
      )}
    >
      {delta}
    </span>
  );
}

type SourceChipKind = "artifact" | "source" | "related-file";

const SOURCE_CHIP =
  "inline-flex max-w-full items-center gap-1 rounded-chip border border-line bg-surface px-1.5 py-0.5 font-mono text-2xs text-ink-soft";

/**
 * Jump to a board element, unfolding the section that holds it first.
 *
 * `foldId` names the TOP-LEVEL section the target lives in, and defaults to the target
 * itself (which is what a section-level chip links to). It has to be given separately for
 * a nested target, because a folded section mounts no body — the target is not in the
 * document to be found through, only the always-mounted top-level section is. The scroll
 * therefore re-resolves the target AFTER the fold, never before.
 *
 * WHEN it re-resolves is the whole correctness of the jump. `Collapse` animates its
 * `grid-template-rows` over `COLLAPSE_MS`, so for that window the newly opened section is
 * still growing from ~0 height: a `scrollIntoView` a frame after the click computes its
 * offset against a section that has barely opened and lands SHORT of the target — the
 * behaviour reads as a jump that missed. So the fold's own duration is what we wait, from
 * the one constant `Collapse` uses (importing it is the point; a second literal 200 here
 * would drift the first time the animation is retuned).
 *
 * Under `prefers-reduced-motion` the track snaps instead of animating, so the geometry is
 * final as soon as the toggle's render commits and the scroll goes on the next frame.
 * Either way it is one frame or one timeout — never a synchronous call, because the
 * toggle's click is dispatched inside our own React event and the target does not exist
 * until that render commits.
 */
export function followBoardAnchor(
  event: MouseEvent<HTMLAnchorElement>,
  targetId: string,
  foldId: string = targetId,
): void {
  event.preventDefault();
  const scroll = () =>
    document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const foldedSection = document
    .getElementById(foldId)
    ?.closest<HTMLElement>('[data-kind="board-section"][data-open="false"]');
  const toggle = foldedSection?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
  if (toggle === undefined || toggle === null) {
    scroll();
    return;
  }
  toggle.click();
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) {
    requestAnimationFrame(scroll);
    return;
  }
  setTimeout(scroll, COLLAPSE_MS);
}

function SourceChip({
  source,
  kind,
  targetId,
}: {
  readonly source: SourceRef;
  readonly kind: SourceChipKind;
  readonly targetId?: string;
}) {
  const reviewId = useBoardReviewId();
  const { mutate: openInEditor, pending } = useMutation("review.openInEditor");
  const label =
    source.label ?? `${source.path}${source.line === undefined ? "" : `:${source.line}`}`;
  const common = {
    "data-kind": `${kind}-chip`,
    "data-source-path": source.path,
    ...(source.line === undefined ? {} : { "data-source-line": source.line }),
  };
  const content = (
    <>
      <Icon icon={FileText} className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </>
  );

  if (targetId !== undefined) {
    return (
      <a
        {...common}
        href={`#${targetId}`}
        data-target-id={targetId}
        aria-label={`Jump to ${label}`}
        title={`Jump to ${label}`}
        onClick={(event) => followBoardAnchor(event, targetId)}
        className={cn(
          SOURCE_CHIP,
          "cursor-pointer hover:border-accent-line hover:bg-raised hover:text-ink",
        )}
      >
        {content}
      </a>
    );
  }

  if (reviewId.length === 0) {
    return (
      <span {...common} data-navigable="false" className={SOURCE_CHIP}>
        {content}
      </span>
    );
  }

  return (
    <button
      {...common}
      type="button"
      disabled={pending}
      aria-label={`Open ${label} in editor`}
      title={`${source.path}${source.line === undefined ? "" : `:${source.line}`}`}
      onClick={() =>
        void openInEditor({
          reviewId,
          path: source.path,
          ...(source.line === undefined ? {} : { line: source.line }),
        }).catch(() => undefined)
      }
      className={cn(
        SOURCE_CHIP,
        "cursor-pointer hover:border-accent-line hover:bg-raised hover:text-ink disabled:cursor-default disabled:opacity-60",
      )}
    >
      {content}
    </button>
  );
}

export function SourceChips({
  sources,
  kind = "source",
  className,
  targetForSource,
}: {
  readonly sources: readonly SourceRef[];
  readonly kind?: SourceChipKind;
  readonly className?: string;
  readonly targetForSource?: (source: SourceRef) => string | undefined;
}) {
  if (sources.length === 0) return null;
  return (
    <div
      data-kind={`${kind}-chips`}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {sources.map((source) => (
        <SourceChip
          key={`${source.candidate ?? ""}:${source.path}:${source.line ?? ""}:${source.label ?? ""}`}
          source={source}
          kind={kind}
          targetId={targetForSource?.(source)}
        />
      ))}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    strings.push(entry);
  }
  return strings;
}

interface ManifestEntry {
  readonly label: string;
  readonly value: string;
}

interface ManifestVerification {
  readonly run: string;
  readonly expected: string;
}

interface TaskManifest {
  readonly files: readonly ManifestEntry[];
  readonly interfaces: readonly ManifestEntry[];
  readonly verifications: readonly ManifestVerification[];
}

function manifestEntries(
  value: unknown,
  labelKey: "operation" | "direction",
): readonly ManifestEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: ManifestEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const label = entry[labelKey];
    if (typeof label !== "string" || typeof entry.value !== "string") return undefined;
    entries.push({ label, value: entry.value });
  }
  return entries;
}

function manifestVerifications(value: unknown): readonly ManifestVerification[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const verifications: ManifestVerification[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.run !== "string" || typeof entry.expected !== "string") {
      return undefined;
    }
    verifications.push({ run: entry.run, expected: entry.expected });
  }
  return verifications;
}

function taskManifest(value: unknown): TaskManifest | undefined {
  if (!isRecord(value)) return undefined;
  const files = manifestEntries(value.files, "operation");
  const interfaces = manifestEntries(value.interfaces, "direction");
  const verifications = manifestVerifications(value.verifications);
  return files === undefined || interfaces === undefined || verifications === undefined
    ? undefined
    : { files, interfaces, verifications };
}

function TaskLinks({
  kind,
  label,
  values,
}: {
  readonly kind: "requirement-refs" | "acceptance-criteria";
  readonly label: string;
  readonly values: readonly string[];
}) {
  if (values.length === 0) return null;
  return (
    <div data-kind={kind} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd>
        <ul className="flex flex-wrap gap-1">
          {values.map((value, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: Source arrays can repeat and expose no identity beyond their exact position.
              key={`${value}:${index}`}
              {...(kind === "requirement-refs"
                ? { "data-requirement-ref": value }
                : { "data-acceptance-criterion": value })}
              className="rounded-chip border border-line bg-raised px-1.5 py-0.5 font-mono text-2xs text-foreground"
            >
              {value}
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

export function DesignTaskMetadata({
  requirementRefs,
  acceptanceCriteria,
}: {
  readonly requirementRefs: unknown;
  readonly acceptanceCriteria: unknown;
}) {
  const refs = stringList(requirementRefs) ?? [];
  const criteria = stringList(acceptanceCriteria) ?? [];
  if (refs.length === 0 && criteria.length === 0) return null;
  return (
    <dl className="mt-2 flex flex-col gap-1.5 border-line/60 border-t pt-2">
      <TaskLinks kind="requirement-refs" label="Requirement refs" values={refs} />
      <TaskLinks kind="acceptance-criteria" label="Acceptance criteria" values={criteria} />
    </dl>
  );
}

export function StoryStatus({ status }: { readonly status: unknown }) {
  if (typeof status !== "string" || status.length === 0) return null;
  return (
    <dl
      data-kind="story-status"
      data-status={status}
      className="inline-flex items-baseline gap-1.5 rounded-chip border border-line bg-raised px-1.5 py-0.5 text-2xs"
    >
      <dt className="text-muted-foreground">Status</dt>
      <dd className="font-medium text-foreground">{status}</dd>
    </dl>
  );
}

function ManifestList({
  part,
  title,
  entries,
}: {
  readonly part: "files" | "interfaces";
  readonly title: string;
  readonly entries: readonly ManifestEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <section data-manifest-part={part} className="min-w-0">
      <h4 className="mb-1.5 font-medium text-xs text-foreground">{title}</h4>
      <dl className="flex flex-col divide-y divide-line/60">
        {entries.map((entry, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: Source arrays can repeat and expose no identity beyond their exact position.
            key={`${entry.label}:${entry.value}:${index}`}
            data-manifest-entry
            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2 py-1.5 text-xs"
          >
            <dt className="text-muted-foreground">{entry.label}</dt>
            <dd className="break-all font-mono text-foreground/85">{entry.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ManifestVerifications({ entries }: { readonly entries: readonly ManifestVerification[] }) {
  if (entries.length === 0) return null;
  return (
    <section data-manifest-part="verifications" className="min-w-0 sm:col-span-2">
      <h4 className="mb-1.5 font-medium text-xs text-foreground">Verifications</h4>
      <ol className="flex list-decimal flex-col gap-2 pl-5 marker:text-muted-foreground">
        {entries.map((entry, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: Source arrays can repeat and expose no identity beyond their exact position.
            key={`${entry.run}:${entry.expected}:${index}`}
            data-manifest-entry
            className="pl-0.5"
          >
            <dl className="grid gap-x-2 gap-y-0.5 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="text-muted-foreground">Run</dt>
              <dd>
                <code className="break-all font-mono text-foreground">{entry.run}</code>
              </dd>
              <dt className="text-muted-foreground">Expected</dt>
              <dd className="text-foreground/80">{entry.expected}</dd>
            </dl>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function DesignGlossaryTerm({
  value,
  fallback,
}: {
  readonly value: unknown;
  readonly fallback: ReactNode;
}) {
  if (!isRecord(value)) return fallback;
  const avoid = stringList(value.avoid);
  if (
    typeof value.term !== "string" ||
    typeof value.definition !== "string" ||
    avoid === undefined
  ) {
    return fallback;
  }
  return (
    <article
      data-kind="glossary-term"
      data-glossary-term={value.term}
      className="flex flex-col gap-2 rounded-surface border border-line bg-raised px-3 py-2.5"
    >
      <h4 className="font-semibold text-base text-foreground">{value.term}</h4>
      <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="font-medium text-muted-foreground">Definition</dt>
        <dd className="text-foreground/90">{value.definition}</dd>
        {avoid.length > 0 ? (
          <>
            <dt className="font-medium text-muted-foreground">Avoid</dt>
            <dd>
              <ul className="flex flex-wrap gap-1">
                {avoid.map((term, index) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: Source arrays can repeat and expose no identity beyond their exact position.
                    key={`${term}:${index}`}
                    data-glossary-avoid={term}
                    className="rounded-chip border border-line bg-raised px-1.5 py-0.5 text-2xs text-foreground"
                  >
                    {term}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
      </dl>
    </article>
  );
}

export function DesignSectionMetadata({
  taskManifest: rawTaskManifest,
}: {
  readonly taskManifest: unknown;
}) {
  const manifest = taskManifest(rawTaskManifest);
  const hasManifest =
    manifest !== undefined &&
    (manifest.files.length > 0 ||
      manifest.interfaces.length > 0 ||
      manifest.verifications.length > 0);
  if (!hasManifest || manifest === undefined) return null;
  return (
    <div
      data-kind="task-manifest"
      className="mt-1 grid gap-x-6 gap-y-3 border-line/60 border-t pt-3 sm:grid-cols-2"
    >
      <ManifestList part="files" title="Files" entries={manifest.files} />
      <ManifestList part="interfaces" title="Interfaces" entries={manifest.interfaces} />
      <ManifestVerifications entries={manifest.verifications} />
    </div>
  );
}
