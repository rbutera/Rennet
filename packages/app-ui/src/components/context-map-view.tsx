import {
  commandIdFor,
  KNOWLEDGE_SWARM_GENERATOR_ID,
  type KnowledgeDispositionResult,
  type KnowledgeSetPayload,
  type KnowledgeStatementPayload,
  type ProjectContextAskResult,
  type ProjectMapPayload,
  type ProjectProcessEvent,
  type ProjectRepositoryAddress,
} from "@rennet/protocol";
import { Spinner } from "@rennet/ui";
import { ArrowLeft, Check, ChevronDown, ChevronRight, RotateCcw, X } from "lucide-react";
import {
  type FormEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildScopes,
  knowledgeForSelection,
  type ScopeNode,
  type Selection,
} from "../context-map/model";
import { useBridge, useCommand, useMutation, useRefreshCommand } from "../data";
import { messageFrom } from "../lib/message-from";
import { Icon } from "./icon";

const short = (name: string) => name.replace("@rennet/", "");

type ExactKnowledgeCoverage = NonNullable<KnowledgeSetPayload["coverage"]>;

interface CoverageTotals {
  readonly mappedFiles: number;
  readonly scopeExcludedFiles: number;
  readonly mechanicallyExcludedFiles: number;
}

type MapKnowledgeCoverage =
  | { readonly kind: "absent" }
  | { readonly kind: "behind" }
  | { readonly kind: "unrecorded" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "current";
      readonly exact: ExactKnowledgeCoverage;
      readonly totals: CoverageTotals;
    };

type SelectionKnowledgeCoverage =
  | Exclude<MapKnowledgeCoverage, { readonly kind: "current" }>
  | {
      readonly kind: "current";
      readonly totals: CoverageTotals;
      readonly scopeReasons: readonly string[];
      readonly mechanicalReasons: readonly string[];
    };

function coverageTotals(coverage: ExactKnowledgeCoverage): CoverageTotals {
  let mappedFiles = 0;
  let scopeExcludedFiles = 0;
  let mechanicallyExcludedFiles = 0;
  for (const group of coverage.groups) {
    if (group.kind === "mapped") mappedFiles += group.files.length;
    else if (group.source === "scope") scopeExcludedFiles += group.files.length;
    else mechanicallyExcludedFiles += group.files.length;
  }
  return { mappedFiles, scopeExcludedFiles, mechanicallyExcludedFiles };
}

function coverageMatchesMap(coverage: ExactKnowledgeCoverage, map: ProjectMapPayload): boolean {
  const covered = new Map<string, string>();
  for (const group of coverage.groups) {
    for (const file of group.files) {
      if (covered.has(file.path)) return false;
      covered.set(file.path, file.blobOid);
    }
  }
  if (covered.size !== map.files.length) return false;
  const mapPaths = new Set<string>();
  for (const file of map.files) {
    if (mapPaths.has(file.path) || covered.get(file.path) !== file.blobOid) return false;
    mapPaths.add(file.path);
  }
  return true;
}

function mapKnowledgeCoverage(
  map: ProjectMapPayload,
  knowledge: KnowledgeSetPayload | null,
): MapKnowledgeCoverage {
  if (knowledge === null) return { kind: "absent" };
  if (knowledge.baseOid !== map.baseOid || knowledge.snapshotFingerprint !== map.fingerprint) {
    return { kind: "behind" };
  }
  if (knowledge.coverage === undefined) {
    return knowledge.generator === KNOWLEDGE_SWARM_GENERATOR_ID
      ? { kind: "invalid" }
      : { kind: "unrecorded" };
  }
  if (!coverageMatchesMap(knowledge.coverage, map)) return { kind: "invalid" };
  return {
    kind: "current",
    exact: knowledge.coverage,
    totals: coverageTotals(knowledge.coverage),
  };
}

function underRoot(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(`${root}/`);
}

function coverageForSelection(
  coverage: MapKnowledgeCoverage,
  selection: Selection,
  scope: ScopeNode | undefined,
): SelectionKnowledgeCoverage {
  if (coverage.kind !== "current") return coverage;
  let mappedFiles = 0;
  let scopeExcludedFiles = 0;
  let mechanicallyExcludedFiles = 0;
  const scopeReasons = new Set<string>();
  const mechanicalReasons = new Set<string>();
  const includes = (path: string): boolean =>
    selection.kind === "file" ? path === selection.path : underRoot(path, scope?.root ?? "");

  for (const group of coverage.exact.groups) {
    const files = group.files.filter((file) => includes(file.path));
    if (files.length === 0) continue;
    if (group.kind === "mapped") mappedFiles += files.length;
    else if (group.source === "scope") {
      scopeExcludedFiles += files.length;
      scopeReasons.add(group.reason);
    } else {
      mechanicallyExcludedFiles += files.length;
      mechanicalReasons.add(group.reason);
    }
  }

  return {
    kind: "current",
    totals: { mappedFiles, scopeExcludedFiles, mechanicallyExcludedFiles },
    scopeReasons: [...scopeReasons],
    mechanicalReasons: [...mechanicalReasons],
  };
}

function coverageCountsLabel(totals: CoverageTotals): string {
  return `${totals.mappedFiles} mapped · ${totals.scopeExcludedFiles} scope-excluded · ${totals.mechanicallyExcludedFiles} mechanically excluded`;
}

function selectionCoverageLabel(coverage: SelectionKnowledgeCoverage): string {
  switch (coverage.kind) {
    case "absent":
      return "Knowledge has not been generated for this map.";
    case "behind":
      return "This knowledge belongs to an earlier map.";
    case "unrecorded":
      return "This older knowledge set did not record model mapping coverage.";
    case "invalid":
      return "The knowledge coverage record does not match this map and is unavailable.";
    case "current":
      return `Selection coverage: ${coverageCountsLabel(coverage.totals)}.`;
  }
}

function emptyKnowledgeLabel(coverage: SelectionKnowledgeCoverage): string {
  if (coverage.kind !== "current") return selectionCoverageLabel(coverage);
  const { totals } = coverage;
  if (
    totals.mappedFiles === 0 &&
    totals.scopeExcludedFiles > 0 &&
    totals.mechanicallyExcludedFiles === 0
  ) {
    const reasons = coverage.scopeReasons.join("; ");
    return `This selection was deliberately excluded from model mapping${reasons === "" ? "." : `: ${reasons}.`}`;
  }
  if (
    totals.mappedFiles === 0 &&
    totals.scopeExcludedFiles === 0 &&
    totals.mechanicallyExcludedFiles > 0
  ) {
    return `This selection was mechanically excluded from model mapping: ${coverage.mechanicalReasons.join(", ")}.`;
  }
  return `No statements were learned for this selection. ${selectionCoverageLabel(coverage)}`;
}

type AskTurn =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "orchestrator"; result: ProjectContextAskResult };

type BuildState =
  | { kind: "idle" }
  | { kind: "processing"; message: string; detail?: string }
  | { kind: "refreshing"; completedRun: boolean }
  | { kind: "error"; message: string; retry: "resume" | "rebuild" };

const CONTEXT_MAP_INVALIDATES = ["project.contextMap"] as const;

function processEventStatus(event: ProjectProcessEvent): {
  readonly message: string;
  readonly detail?: string;
} {
  switch (event.kind) {
    case "run-state":
      return {
        message:
          event.phase === "scout"
            ? "Learning the project…"
            : event.phase === "map"
              ? "Building the Context Map…"
              : event.phase === "knowledge"
                ? "Learning what the code does…"
                : "Opening the Context Map…",
        detail: event.detail,
      };
    case "step":
    case "stage":
      return { message: event.note, detail: event.detail };
    case "scout-ready":
      return { message: `Learned the project shape for ${event.repo}.` };
    case "repo-start":
      return {
        message: `Building the Context Map for ${event.repo}…`,
        detail: `Repository ${event.index} of ${event.total}`,
      };
    case "repo-done":
      return { message: `Finished the Context Map for ${event.repo}.` };
    case "repo-error":
      return { message: `Could not process ${event.repo}.`, detail: event.message };
    case "done":
      return { message: "Opening the Context Map…" };
  }
}

/**
 * The Context Map surface (change add-context-map-view).
 *
 * A per-project view of the Repo Map: the deterministic structure (scopes → dirs →
 * files, with dependency edges) on the left, the model-derived knowledge layer in the
 * middle, and a project-scoped orchestrator ask rail on the right. Structure and
 * knowledge are read verbatim over `project.contextMap`; a knowledge statement is
 * confirmed/rejected through `project.knowledgeDisposition`; the rail speaks
 * `project.contextAsk` — a real turn through the user's own harness. Nothing here is
 * fabricated: an absent snapshot is stated plainly, and the ask rail's unanswered and
 * failed states are first-class.
 */
/** The prefill a "discuss" action carries — the statement, framed as a revise-it ask. Shared
 *  by the ask-rail prefill and the New-Chat handoff so both phrase it identically. */
export function discussPrompt(statement: KnowledgeStatementPayload): string {
  return `About "${statement.subject}": the claim "${statement.claim}" — is this right? Revise it against the evidence.`;
}

/**
 * The Context Map's takeover header — the 40px tier every takeover surface carries
 * (board prototype `components/context-map.tsx`): an icon back button, the
 * `project › Context Map` trail, and the `esc` hint that `ContextMapView`'s window
 * handler makes true. It renders identically over the loading/error state and the
 * loaded map, so the header does not resize under the reviewer when the map arrives.
 */
function MapHeader({ projectId, onBack }: { projectId: string; onBack(): void }) {
  const { data: projectsData } = useCommand("projects.list", {});
  // The id is the honest fallback until the list resolves — never a placeholder name.
  const projectName =
    (projectsData?.projects ?? []).find((candidate) => candidate.id === projectId)?.name ??
    projectId;
  return (
    <header className="context-map-bar flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-3">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="context-map-back mr-0.5 flex size-6 items-center justify-center rounded-control text-ink-soft transition-colors hover:bg-raised hover:text-ink"
      >
        <Icon icon={ArrowLeft} className="size-3.5" />
      </button>
      <span className="flex min-w-0 items-center gap-1.5 text-13">
        <span className="shrink-0 font-medium text-ink">{projectName}</span>
        <Icon icon={ChevronRight} className="size-3 shrink-0 text-muted-foreground/50" />
        <span className="context-map-title text-ink-soft">Context Map</span>
      </span>
      <kbd className="ml-auto rounded-chip border border-line px-1 py-0.5 text-10 text-ink-faint">
        esc
      </kbd>
    </header>
  );
}

export function ContextMapView({
  projectId,
  repositoryAddress,
  onBack,
  showAskRail = true,
  takeover = true,
  onDiscuss,
}: {
  projectId: string;
  repositoryAddress?: ProjectRepositoryAddress;
  onBack(): void;
  /** The project-scoped ask rail. The router-side map view (C12) hides it — the
   *  session chat column plays that role there — and leaves it on elsewhere. */
  showAskRail?: boolean;
  /** Whether this mount OWNS the window: it then carries the 40px takeover header (Back,
   *  the `project › Context Map` trail, the `esc` keycap) and the window Escape handler
   *  that keycap advertises. False for the in-session `?view=map` mount, which sits INSIDE
   *  the session's own chrome — a second Back, a second trail and a stolen Escape there
   *  are all the session's chrome duplicated or overridden. */
  takeover?: boolean;
  /** Where a statement's "discuss" goes when there is no ask rail (the router map view hands
   *  it to the project's New Chat, prefilled). Absent AND no ask rail ⇒ no discuss button. */
  onDiscuss?(statement: KnowledgeStatementPayload): void;
}) {
  const bridge = useBridge();
  const [selectedRepository, setSelectedRepository] = useState<
    ProjectRepositoryAddress | undefined
  >(undefined);
  const addressedRepository = repositoryAddress ?? selectedRepository;
  const contextInput = {
    projectId,
    ...(addressedRepository === undefined ? {} : addressedRepository),
  };
  const mapQuery = useCommand("project.contextMap", contextInput);
  const refreshMap = useRefreshCommand("project.contextMap");
  const { mutate: process } = useMutation("project.process", {
    invalidates: CONTEXT_MAP_INVALIDATES,
  });
  const [build, setBuild] = useState<BuildState>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);
  const [retryMode, setRetryMode] = useState<"resume" | "rebuild">("resume");
  const started = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (mapQuery.data?.status !== "absent") return;
    if (mapQuery.data.run?.status === "done" && retryMode !== "rebuild") {
      setBuild({ kind: "error", message: mapQuery.data.reason, retry: "rebuild" });
      return;
    }
    const repositoryKey =
      addressedRepository?.forgeRepository === undefined
        ? (addressedRepository?.repository ?? "project")
        : `${addressedRepository.forgeRepository.forge}:${addressedRepository.repository}`;
    const runKey = `${projectId}:${repositoryKey}:${attempt}`;
    if (started.current === runKey) return;
    started.current = runKey;
    let live = true;
    const commandId =
      retryMode === "rebuild"
        ? commandIdFor(`project.process:${projectId}:rebuild:${mapQuery.data.run?.id ?? attempt}`)
        : (mapQuery.data.run?.id ?? commandIdFor(`project.process:${projectId}`));
    const unsubscribe = bridge.onProgress?.(commandId, (event) => {
      if (!live) return;
      setBuild({ kind: "processing", ...processEventStatus(event) });
    });
    setBuild({ kind: "processing", message: "Starting the Context Map…" });
    void process({ commandId, projectId }).then(
      ({ run }) => {
        if (!live) return;
        setBuild(
          run?.status === "failed"
            ? {
                kind: "error",
                message: `Context Map ${run.phase} failed: ${run.reason}`,
                retry: "resume",
              }
            : { kind: "refreshing", completedRun: run?.status === "done" },
        );
      },
      (reason: unknown) => {
        if (live) setBuild({ kind: "error", message: messageFrom(reason), retry: "resume" });
      },
    );
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [addressedRepository, attempt, bridge, mapQuery.data, process, projectId, retryMode]);

  useEffect(() => {
    if (
      build.kind === "refreshing" &&
      mapQuery.data?.status === "absent" &&
      !mapQuery.fetching &&
      !mapQuery.stale
    ) {
      setBuild({
        kind: "error",
        message: mapQuery.data.reason,
        retry: build.completedRun ? "rebuild" : "resume",
      });
    }
  }, [build, mapQuery.data, mapQuery.fetching, mapQuery.stale]);

  // Escape leaves the map, the way every other takeover surface behaves — which is what
  // makes the header's `esc` hint true rather than decoration. Only when this mount IS the
  // takeover: embedded in a session, a window-wide Escape handler would fire from the chat
  // composer and navigate the reviewer off the map they were reading.
  useEffect(() => {
    if (!takeover) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onBack();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack, takeover]);

  if (mapQuery.data?.status === "ok" && !mapQuery.error && !mapQuery.fetching && !mapQuery.stale) {
    return (
      <ContextMap
        projectId={projectId}
        repositoryAddress={addressedRepository}
        map={mapQuery.data.map}
        knowledge={mapQuery.data.knowledge}
        onBack={onBack}
        showAskRail={showAskRail}
        takeover={takeover}
        onDiscuss={onDiscuss}
      />
    );
  }
  if (
    mapQuery.data?.status === "members" &&
    !mapQuery.error &&
    !mapQuery.fetching &&
    !mapQuery.stale
  ) {
    return (
      <ContextMapMembers
        members={mapQuery.data.members}
        onBack={onBack}
        onSelect={setSelectedRepository}
      />
    );
  }
  return (
    <div className="context-map flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      {takeover ? <MapHeader projectId={projectId} onBack={onBack} /> : null}
      <div className="context-map-status flex max-w-xl flex-col gap-3 px-8 py-10 text-ink-soft">
        <div className="flex items-center gap-2 font-serif text-base">
          {mapQuery.pending || build.kind === "processing" || build.kind === "refreshing" ? (
            <Spinner className="size-4 text-accent" />
          ) : null}
          <span role={mapQuery.error || build.kind === "error" ? "alert" : undefined}>
            {mapQuery.error
              ? messageFrom(mapQuery.error)
              : mapQuery.pending
                ? "Loading the Context Map…"
                : build.kind === "processing"
                  ? build.message
                  : build.kind === "refreshing"
                    ? "Opening the Context Map…"
                    : build.kind === "error"
                      ? build.message
                      : mapQuery.data?.status === "absent"
                        ? "Starting the Context Map…"
                        : "Loading the Context Map…"}
          </span>
        </div>
        {build.kind === "processing" && build.detail ? (
          <p className="font-mono text-xs text-ink-faint">{build.detail}</p>
        ) : null}
        {mapQuery.error || build.kind === "error" ? (
          <button
            type="button"
            className="inline-flex w-fit items-center gap-1.5 rounded-chip border border-line px-2.5 py-1.5 text-sm text-ink-soft transition-colors hover:bg-raised hover:text-ink"
            onClick={() => {
              setRetryMode(build.kind === "error" ? build.retry : "resume");
              setBuild({ kind: "idle" });
              refreshMap();
              setAttempt((current) => current + 1);
            }}
          >
            <Icon icon={RotateCcw} className="size-3.5" />
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ContextMapMembers({
  members,
  onBack,
  onSelect,
}: {
  readonly members: readonly ProjectRepositoryAddress[];
  readonly onBack: () => void;
  readonly onSelect: (member: ProjectRepositoryAddress) => void;
}) {
  return (
    <div className="context-map min-h-screen flex flex-col bg-canvas">
      <header className="context-map-bar flex items-center gap-4 px-6 pt-5 pb-4 border-b border-line">
        <button
          type="button"
          onClick={onBack}
          className="context-map-back inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-chip border border-line text-ink-soft hover:bg-raised hover:text-ink"
        >
          <Icon icon={ArrowLeft} className="h-3.5 w-3.5" />
          Back
        </button>
        <h1 className="context-map-title font-display text-xl text-ink">Context Map</h1>
      </header>
      <div className="context-map-members flex max-w-xl flex-col gap-3 px-8 py-10">
        <p className="font-serif text-base text-ink-soft">
          Choose the repository whose Context Map you want to read.
        </p>
        <div className="flex flex-col gap-2">
          {members.map((member) => {
            const provider = member.forgeRepository?.forge;
            const key =
              provider === undefined ? member.repository : `${provider}:${member.repository}`;
            return (
              <button
                key={key}
                type="button"
                className="context-map-member rounded-card border border-line px-4 py-3 text-left text-ink hover:bg-raised"
                onClick={() => onSelect(member)}
              >
                <span className="font-mono text-sm">{member.repository}</span>
                {provider === undefined ? null : (
                  <span className="ml-2 text-xs text-ink-faint">{provider}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ContextMap({
  projectId,
  repositoryAddress,
  map,
  knowledge,
  onBack,
  showAskRail,
  takeover,
  onDiscuss,
}: {
  projectId: string;
  repositoryAddress?: ProjectRepositoryAddress;
  map: ProjectMapPayload;
  knowledge: KnowledgeSetPayload | null;
  onBack(): void;
  showAskRail: boolean;
  takeover: boolean;
  onDiscuss?(statement: KnowledgeStatementPayload): void;
}) {
  const { mutate: persistDisposition } = useMutation("project.knowledgeDisposition");
  const scopes = useMemo(() => buildScopes(map), [map]);
  const [selection, setSelection] = useState<Selection>(
    scopes[0] ? { kind: "scope", scope: scopes[0].name } : { kind: "scope", scope: "" },
  );
  const [statements, setStatements] = useState<KnowledgeStatementPayload[]>(
    knowledge?.statements ? [...knowledge.statements] : [],
  );
  const selectedScope =
    scopes.find((scope) =>
      selection.kind === "file" ? scope.name === selection.scope : scope.name === selection.scope,
    ) ?? scopes[0];

  const [dispositionError, setDispositionError] = useState<string | null>(null);
  const disposition = async (statementId: string, next: "confirmed" | "rejected") => {
    const prior = statements.find((entry) => entry.id === statementId)?.status;
    // Optimistic flip for responsiveness; the server's answer is authoritative and
    // reconciles below — a failed or not-found disposition rolls back, never leaves a
    // guessed status standing (a lie in the UI is a bug).
    setStatements((current) =>
      current.map((entry) => (entry.id === statementId ? { ...entry, status: next } : entry)),
    );
    setDispositionError(null);
    const rollback = () =>
      setStatements((current) =>
        current.map((entry) =>
          entry.id === statementId && prior ? { ...entry, status: prior } : entry,
        ),
      );
    try {
      const result = (await persistDisposition({
        projectId,
        ...(repositoryAddress === undefined ? {} : repositoryAddress),
        statementId,
        disposition: next,
      })) as KnowledgeDispositionResult;
      if (result.status === "ok") {
        // Apply the persisted statement verbatim — the store, not the optimism, wins.
        setStatements((current) =>
          current.map((entry) => (entry.id === statementId ? result.statement : entry)),
        );
      } else {
        rollback();
        setDispositionError("That statement is no longer in the map — the view may be stale.");
      }
    } catch (reason) {
      rollback();
      setDispositionError(messageFrom(reason));
    }
  };

  const askRef = useRef<{ prefill(text: string): void }>(null);
  // The discuss handler: with the ask rail present, prefill it; otherwise defer to the
  // caller's handoff (the router map view sends it to New Chat). Undefined ⇒ the button is
  // not rendered at all — never an inert control that looks live but does nothing.
  const discuss = showAskRail
    ? (statement: KnowledgeStatementPayload) => askRef.current?.prefill(discussPrompt(statement))
    : onDiscuss;

  const fileCount = map.files.length;
  const modelCoverage = mapKnowledgeCoverage(map, knowledge);
  const selectedCoverage = coverageForSelection(modelCoverage, selection, selectedScope);
  const coverageIsCurrent = modelCoverage.kind === "current";
  const freshnessLabel =
    modelCoverage.kind === "behind"
      ? "◐ knowledge behind map"
      : modelCoverage.kind === "absent"
        ? "○ knowledge not generated"
        : modelCoverage.kind === "unrecorded"
          ? "◐ knowledge current · coverage unrecorded"
          : modelCoverage.kind === "invalid"
            ? "◐ knowledge coverage invalid"
            : `● knowledge current · ${coverageCountsLabel(modelCoverage.totals)}`;
  return (
    <div className="context-map flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      {takeover ? <MapHeader projectId={projectId} onBack={onBack} /> : null}
      {/* The base strip is its OWN row under the 40px header (prototype `MapBaseLine`),
          never folded into it: the header is the takeover tier, and what the map was
          built from is content about the map. Embedded in a session there is no header
          above it and this strip leads the surface, which is the prototype's split
          between `ContextMapFullView` and the embedded panel. */}
      <div className="context-map-base-strip flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        {/* biome-ignore lint/a11y/useSemanticElements: the global h1 typography changes this embedded strip's styling; ARIA restores the heading semantics without overriding the styling contract. */}
        <span role="heading" aria-level={1} className="shrink-0 text-sm font-medium text-ink">
          Context Map
        </span>
        <span className="context-map-base truncate font-mono text-sm text-ink-faint">
          {knowledge?.repoKey ?? map.baseRef} · {map.baseRef} @ {map.baseOid.slice(0, 12)}
        </span>
        <span
          className={`context-map-fresh ml-auto inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-full border bg-surface text-10 font-semibold ${
            coverageIsCurrent ? "border-green-line text-green" : "border-line text-ink-soft"
          }`}
        >
          {freshnessLabel}
        </span>
      </div>
      <div className="context-map-main flex flex-1 min-h-0">
        <section className="context-map-col flex flex-col min-w-0 w-64 shrink-0 border-r border-line">
          <div className="context-map-col-title px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-ink-faint border-b border-line">
            Structure — {map.scopes.length} scopes · {fileCount.toLocaleString()} files
          </div>
          <div className="context-map-scroll flex-1 overflow-auto py-1.5">
            <Tree scopes={scopes} selection={selection} onSelect={setSelection} />
          </div>
        </section>
        <section className="context-map-col flex flex-col flex-1 min-w-0 border-r border-line">
          <div className="context-map-graph border-b border-line p-4">
            <Neighborhood
              scope={selectedScope}
              onSelect={(name) => setSelection({ kind: "scope", scope: name })}
            />
          </div>
          {dispositionError ? (
            <div className="context-map-disposition-error px-4 py-2 text-2xs text-danger border-b border-danger-soft bg-danger-soft">
              {dispositionError}
            </div>
          ) : null}
          <DetailTabs
            selection={selection}
            scope={selectedScope}
            statements={statements}
            coverage={selectedCoverage}
            map={map}
            onConfirm={(id) => void disposition(id, "confirmed")}
            onReject={(id) => void disposition(id, "rejected")}
            onDiscuss={discuss}
          />
        </section>
        {showAskRail ? (
          <section className="context-map-col flex flex-col min-w-0 w-[24rem]">
            <div className="context-map-col-title px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-ink-faint border-b border-line">
              Orchestrator — project session
            </div>
            <AskRail ref={askRef} projectId={projectId} repositoryAddress={repositoryAddress} />
          </section>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tree ----
function Tree({
  scopes,
  selection,
  onSelect,
}: {
  scopes: ScopeNode[];
  selection: Selection;
  onSelect(next: Selection): void;
}) {
  return (
    <div className="context-map-tree font-mono text-xs">
      {scopes.map((scope) => (
        <ScopeRow key={scope.name} scope={scope} selection={selection} onSelect={onSelect} />
      ))}
    </div>
  );
}

// Selection is the quiet raised ground, not gold — gold is the reserve. The hover
// tone is deliberately HALF that ground (`bg-secondary/50`): at full strength a
// hovered row is pixel-identical to the selected one and impersonates it.
function rowClass(selected: boolean): string {
  return `context-map-row flex items-center gap-1.5 w-full py-1 pr-3 text-left transition-colors ${
    selected
      ? "is-selected bg-secondary text-foreground"
      : "text-ink-soft hover:bg-secondary/50 hover:text-ink"
  }`;
}

/** The fold marker: ONE chevron that rotates, not two glyphs swapped. The rotation is
 *  the affordance — a static `▾`/`▸` pair reads as two different characters blinking. */
function Twisty({ open }: { open: boolean }) {
  return (
    <Icon
      icon={ChevronDown}
      className={`context-map-twist size-3 shrink-0 text-ink-faint transition-transform ${
        open ? "" : "-rotate-90"
      }`}
    />
  );
}

function ScopeRow({
  scope,
  selection,
  onSelect,
}: {
  scope: ScopeNode;
  selection: Selection;
  onSelect(next: Selection): void;
}) {
  const [open, setOpen] = useState(false);
  const selected = selection.kind === "scope" && selection.scope === scope.name;
  return (
    <div>
      <button
        type="button"
        className={rowClass(selected)}
        style={{ paddingLeft: "0.75rem" }}
        onClick={() => {
          setOpen(selected ? !open : true);
          onSelect({ kind: "scope", scope: scope.name });
        }}
      >
        <Twisty open={open} />
        <span className="context-map-name flex-1 truncate">{short(scope.name)}</span>
        <span className="context-map-count text-10 text-ink-faint">
          {scope.in.length > 0 ? `⇦${scope.in.length} ` : ""}
          {scope.tree.fileCount}f
        </span>
      </button>
      {open ? (
        <DirChildren
          node={scope.tree}
          scope={scope.name}
          depth={1}
          selection={selection}
          onSelect={onSelect}
        />
      ) : null}
    </div>
  );
}

function DirChildren({
  node,
  scope,
  depth,
  selection,
  onSelect,
}: {
  node: ScopeNode["tree"];
  scope: string;
  depth: number;
  selection: Selection;
  onSelect(next: Selection): void;
}) {
  return (
    <>
      {node.dirs.map((dir) => (
        <DirRow
          key={dir.path}
          dir={dir}
          scope={scope}
          depth={depth}
          selection={selection}
          onSelect={onSelect}
        />
      ))}
      {node.files.map((file) => (
        <FileRow
          key={file.path}
          file={file}
          scope={scope}
          depth={depth}
          selection={selection}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function DirRow({
  dir,
  scope,
  depth,
  selection,
  onSelect,
}: {
  dir: ScopeNode["tree"];
  scope: string;
  depth: number;
  selection: Selection;
  onSelect(next: Selection): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className={rowClass(false)}
        style={{ paddingLeft: `${0.75 + depth * 0.85}rem` }}
        onClick={() => setOpen(!open)}
      >
        <Twisty open={open} />
        <span className="context-map-name flex-1 truncate">{dir.name}/</span>
        <span className="context-map-count text-10 text-ink-faint">{dir.fileCount}f</span>
      </button>
      {open ? (
        <DirChildren
          node={dir}
          scope={scope}
          depth={depth + 1}
          selection={selection}
          onSelect={onSelect}
        />
      ) : null}
    </div>
  );
}

function FileRow({
  file,
  scope,
  depth,
  selection,
  onSelect,
}: {
  file: { path: string };
  scope: string;
  depth: number;
  selection: Selection;
  onSelect(next: Selection): void;
}) {
  const selected = selection.kind === "file" && selection.path === file.path;
  const base = file.path.split("/").at(-1) ?? file.path;
  return (
    <button
      type="button"
      className={rowClass(selected)}
      style={{ paddingLeft: `${0.75 + depth * 0.85}rem` }}
      onClick={() => onSelect({ kind: "file", scope, path: file.path })}
    >
      <span className="context-map-twist size-3 shrink-0" />
      <span className="context-map-name flex-1 truncate text-2xs">{base}</span>
    </button>
  );
}

// --------------------------------------------------------------- graph ----
function Neighborhood({
  scope,
  onSelect,
}: {
  scope: ScopeNode | undefined;
  onSelect(name: string): void;
}) {
  if (!scope)
    return <div className="context-map-graph-empty text-sm text-ink-faint">No scope selected.</div>;
  const outs = scope.out;
  const ins = scope.in;
  if (outs.length === 0 && ins.length === 0) {
    return (
      <div className="context-map-graph-empty text-sm text-ink-faint">
        No dependency edges recorded for {scope.name}.
      </div>
    );
  }
  const width = 720;
  // The canvas grows with the busier side rather than sitting at a fixed 300: a scope
  // with eight importers stops cramming its nodes into a strip they overlap in, and a
  // scope with one stops floating in empty space. 44px per node is the row pitch that
  // keeps the 28px node boxes apart; 200 is the floor a one-edge neighborhood needs.
  const height = Math.max(200, Math.max(ins.length, outs.length) * 44 + 60);
  const cx = width / 2;
  const cy = height / 2;
  const nodeWidth = 128;
  const place = (list: string[], side: "left" | "right") =>
    list.map((name, index) => {
      const step = height / (list.length + 1);
      return { name, x: side === "left" ? 110 : width - 110, y: step * (index + 1) };
    });
  const inNodes = place(ins, "left");
  const outNodes = place(outs, "right");
  return (
    <svg
      className="context-map-svg w-full h-auto"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Dependency neighborhood of ${scope.name}`}
    >
      <defs>
        <marker
          id="cm-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 0 L8 4 L0 8 z" fill="var(--rn-ink-faint)" />
        </marker>
      </defs>
      {inNodes.map((node) => (
        <line
          key={`in-${node.name}`}
          stroke="var(--rn-line-strong)"
          markerEnd="url(#cm-arrow)"
          x1={node.x + nodeWidth / 2}
          y1={node.y}
          x2={cx - nodeWidth / 2 - 6}
          y2={cy}
        />
      ))}
      {outNodes.map((node) => (
        <line
          key={`out-${node.name}`}
          stroke="var(--rn-line-strong)"
          markerEnd="url(#cm-arrow)"
          x1={cx + nodeWidth / 2}
          y1={cy}
          x2={node.x - nodeWidth / 2 - 6}
          y2={node.y}
        />
      ))}
      {[...inNodes, ...outNodes].map((node) => (
        // biome-ignore lint/a11y/useSemanticElements: a <button> cannot exist inside <svg>; role is the SVG-correct affordance
        <g
          key={node.name}
          role="button"
          tabIndex={0}
          className="context-map-node cursor-pointer"
          onClick={() => onSelect(node.name)}
          onKeyDown={(event) => event.key === "Enter" && onSelect(node.name)}
        >
          <rect
            fill="var(--rn-raised)"
            stroke="var(--rn-line-strong)"
            x={node.x - nodeWidth / 2}
            y={node.y - 14}
            width={nodeWidth}
            height={28}
            rx="6"
          />
          <text fill="var(--rn-ink)" fontSize="12" x={node.x} y={node.y + 4} textAnchor="middle">
            {short(node.name)}
          </text>
        </g>
      ))}
      <rect
        fill="var(--rn-accent-surface)"
        stroke="var(--rn-accent-line)"
        x={cx - nodeWidth / 2}
        y={cy - 16}
        width={nodeWidth}
        height={32}
        rx="6"
      />
      <text fill="var(--rn-ink)" fontSize="13" x={cx} y={cy + 4} textAnchor="middle">
        {short(scope.name)}
      </text>
      {ins.length > 0 ? (
        <text fill="var(--rn-ink-faint)" fontSize="11" x={110} y={16} textAnchor="middle">
          imported by
        </text>
      ) : null}
      {outs.length > 0 ? (
        <text fill="var(--rn-ink-faint)" fontSize="11" x={width - 110} y={16} textAnchor="middle">
          imports
        </text>
      ) : null}
    </svg>
  );
}

// ---------------------------------------------------------------- tabs ----
function DetailTabs({
  selection,
  scope,
  statements,
  coverage,
  map,
  onConfirm,
  onReject,
  onDiscuss,
}: {
  selection: Selection;
  scope: ScopeNode | undefined;
  statements: KnowledgeStatementPayload[];
  coverage: SelectionKnowledgeCoverage;
  map: ProjectMapPayload;
  onConfirm(id: string): void;
  onReject(id: string): void;
  onDiscuss?(statement: KnowledgeStatementPayload): void;
}) {
  const [tab, setTab] = useState<"knowledge" | "details">("knowledge");
  const subject = selection.kind === "file" ? selection.path : (scope?.name ?? "");
  const relevant = knowledgeForSelection(statements, selection, scope);
  return (
    <div className="context-map-detail flex flex-col flex-1 min-h-0">
      <div className="context-map-tabs flex gap-1 px-4 pt-2 border-b border-line">
        {(["knowledge", "details"] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={`context-map-tab px-3 py-1.5 rounded-t-md text-12-5 transition-colors ${
              tab === name
                ? "is-active text-ink border-b-2 border-accent"
                : "text-ink-soft hover:text-ink"
            }`}
            onClick={() => setTab(name)}
          >
            {name === "knowledge" ? `Knowledge (${relevant.length})` : "Details"}
          </button>
        ))}
      </div>
      <div className="context-map-scroll flex-1 overflow-auto p-4">
        {tab === "knowledge" ? (
          <KnowledgePanel
            statements={relevant}
            subject={subject}
            coverage={coverage}
            onConfirm={onConfirm}
            onReject={onReject}
            onDiscuss={onDiscuss}
          />
        ) : (
          <DetailsPanel selection={selection} scope={scope} map={map} />
        )}
      </div>
    </div>
  );
}

function KnowledgePanel({
  statements,
  subject,
  coverage,
  onConfirm,
  onReject,
  onDiscuss,
}: {
  statements: KnowledgeStatementPayload[];
  subject: string;
  coverage: SelectionKnowledgeCoverage;
  onConfirm(id: string): void;
  onReject(id: string): void;
  onDiscuss?(statement: KnowledgeStatementPayload): void;
}) {
  return (
    <div className="context-map-knowledge flex flex-col gap-3">
      <p className="context-map-note text-sm text-ink-faint">
        Model-derived, evidence-backed statements about {subject}. Each stays a labelled hypothesis
        until evidence or a human confirms it.
      </p>
      <p className="context-map-coverage text-sm text-ink-faint">
        {selectionCoverageLabel(coverage)}
      </p>
      {statements.length === 0 ? (
        <p className="context-map-note text-sm text-ink-faint">{emptyKnowledgeLabel(coverage)}</p>
      ) : null}
      {statements.map((statement) => (
        <article
          key={statement.id}
          className={`context-map-claim rounded-md border p-3 ${
            statement.status === "rejected"
              ? "border-line bg-surface opacity-60"
              : statement.status === "confirmed"
                ? "border-green-line bg-surface"
                : "border-line bg-secondary/30"
          }`}
        >
          <div className="context-map-claim-head flex items-center gap-2 mb-1.5">
            <span className="context-map-claim-subject font-mono text-xs text-ink-soft truncate flex-1">
              {statement.subject}
            </span>
            <span className="context-map-conf text-2xs uppercase text-ink-faint">
              {statement.confidence}
            </span>
            <span
              className={`context-map-state px-1.5 py-0.5 rounded-full text-2xs font-semibold ${
                statement.status === "confirmed"
                  ? "bg-green-soft text-green"
                  : statement.status === "rejected"
                    ? "bg-surface text-ink-faint"
                    : // Verdigris, the machine's voice: an unconfirmed statement is the
                      // model talking, and gold is not the model's colour.
                      "bg-model-soft text-model"
              }`}
            >
              {statement.status}
            </span>
          </div>
          <div className="context-map-claim-body text-13 leading-relaxed text-foreground/90">
            {statement.claim}
          </div>
          <div className="context-map-claim-evidence mt-1.5 text-2xs text-ink-faint font-mono truncate">
            evidence: {statement.evidence.map((anchor) => anchor.path).join(", ") || "—"} ·{" "}
            {statement.provenance.generator}
          </div>
          {statement.status !== "confirmed" && statement.status !== "rejected" ? (
            <div className="context-map-claim-actions flex gap-2 mt-2.5">
              <button
                type="button"
                onClick={() => onConfirm(statement.id)}
                className="context-map-confirm inline-flex items-center gap-1 px-2 py-1 rounded-md border border-green-line text-green text-2xs transition-colors hover:bg-green-soft"
              >
                <Icon icon={Check} className="size-3" /> confirm
              </button>
              <button
                type="button"
                onClick={() => onReject(statement.id)}
                className="context-map-reject inline-flex items-center gap-1 px-2 py-1 rounded-md border border-line text-ink-soft text-2xs transition-colors hover:bg-raised hover:text-danger"
              >
                <Icon icon={X} className="size-3" /> reject
              </button>
              {onDiscuss ? (
                <button
                  type="button"
                  onClick={() => onDiscuss(statement)}
                  className="context-map-discuss inline-flex items-center gap-1 px-2 py-1 rounded-md border border-line text-ink-soft text-2xs transition-colors hover:bg-raised hover:text-ink"
                >
                  ↪ discuss
                </button>
              ) : null}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function DetailsPanel({
  selection,
  scope,
  map,
}: {
  selection: Selection;
  scope: ScopeNode | undefined;
  map: ProjectMapPayload;
}) {
  if (selection.kind === "file") {
    return (
      <dl className="context-map-kv grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-12-5">
        <dt className="text-ink-faint">path</dt>
        <dd className="font-mono text-ink truncate">{selection.path}</dd>
        <dt className="text-ink-faint">scope</dt>
        <dd className="text-ink">{selection.scope}</dd>
      </dl>
    );
  }
  if (!scope) return null;
  return (
    <dl className="context-map-kv grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-12-5">
      <dt className="text-ink-faint">scope</dt>
      <dd className="text-ink">{scope.name}</dd>
      <dt className="text-ink-faint">root</dt>
      <dd className="font-mono text-ink truncate">{scope.root || "(repo root)"}</dd>
      <dt className="text-ink-faint">files</dt>
      <dd className="text-ink">{scope.tree.fileCount}</dd>
      <dt className="text-ink-faint">tests</dt>
      <dd className="text-ink">{scope.testCount}</dd>
      <dt className="text-ink-faint">imports</dt>
      <dd className="text-ink truncate">{scope.out.map(short).join(", ") || "—"}</dd>
      <dt className="text-ink-faint">imported by</dt>
      <dd className="text-ink truncate">{scope.in.map(short).join(", ") || "—"}</dd>
      <dt className="text-ink-faint">conventions</dt>
      <dd className="text-ink">{map.conventions.length} recorded</dd>
    </dl>
  );
}

// ---------------------------------------------------------------- rail ----
const AskRail = forwardRef<
  { prefill(text: string): void },
  { projectId: string; repositoryAddress?: ProjectRepositoryAddress }
>(function AskRail({ projectId, repositoryAddress }, ref) {
  const { mutate: ask } = useMutation("project.contextAsk");
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    prefill(text: string) {
      if (inputRef.current) {
        inputRef.current.value = text;
        inputRef.current.focus();
      }
    },
  }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = inputRef.current?.value.trim();
    if (!text || busy) return;
    if (inputRef.current) inputRef.current.value = "";
    const question = { id: crypto.randomUUID(), role: "user" as const, text };
    setTurns((current) => [...current, question]);
    setBusy(true);
    try {
      const result = await ask({
        projectId,
        ...(repositoryAddress === undefined ? {} : repositoryAddress),
        question: text,
      });
      setTurns((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "orchestrator", result },
      ]);
    } catch (reason) {
      setTurns((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "orchestrator",
          result: {
            status: "failed",
            failureReason: messageFrom(reason),
            cost: {
              turns: 0,
              model: null,
              effort: null,
              budgetGranted: false,
              overage: false,
              resolution: null,
            },
          },
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="context-map-log flex-1 overflow-auto p-4 flex flex-col gap-3">
        {turns.length === 0 ? (
          <p className="context-map-note text-sm text-ink-faint">
            Ask the orchestrator about this project. Answers cite the map and knowledge as evidence.
          </p>
        ) : null}
        {turns.map((turn) => (
          <AskBubble key={turn.id} turn={turn} />
        ))}
        {busy ? <p className="context-map-note text-sm text-ink-faint">Thinking…</p> : null}
      </div>
      <form className="context-map-input flex gap-2 p-3 border-t border-line" onSubmit={submit}>
        <input
          ref={inputRef}
          placeholder="Ask about this project…"
          aria-label="Message the orchestrator"
          className="context-map-field flex-1 min-w-0 px-3 py-2 rounded-control border border-line bg-surface text-ink text-base"
        />
        <button
          type="submit"
          disabled={busy}
          className="context-map-send px-3 py-2 rounded-control border border-accent-line bg-accent-soft text-ink text-sm disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </>
  );
});

function AskBubble({ turn }: { turn: AskTurn }) {
  if (turn.role === "user") {
    return (
      <div className="context-map-msg is-user self-end max-w-[85%]">
        <div className="context-map-who text-2xs uppercase text-ink-faint mb-0.5 text-right">
          you
        </div>
        <div className="context-map-bubble rounded-surface border border-accent-line bg-accent-surface px-3 py-2 text-base text-ink">
          {turn.text}
        </div>
      </div>
    );
  }
  const result = turn.result;
  const coverageConsulted =
    result.status === "failed"
      ? undefined
      : result.answer.consulted.find((entry) => entry.startsWith("context.knowledge coverage"));
  return (
    <div className="context-map-msg is-orchestrator self-start max-w-[85%]">
      <div className="context-map-who text-2xs uppercase text-ink-faint mb-0.5">orchestrator</div>
      {result.status === "failed" ? (
        <div className="context-map-bubble rounded-surface border border-danger bg-danger-soft px-3 py-2 text-base text-danger">
          Couldn’t answer: {result.failureReason}
        </div>
      ) : (
        <div className="context-map-bubble rounded-surface border border-line bg-raised px-3 py-2 text-base text-ink">
          {result.answer.answer}
          {result.status === "unanswered" && result.answer.unanswered ? (
            <div className="context-map-unanswered mt-1.5 text-sm text-ink-faint">
              Unanswered: {result.answer.unanswered.reason}
            </div>
          ) : null}
          {result.answer.evidence.length > 0 ? (
            <div className="context-map-evidence mt-1.5 text-2xs text-ink-faint font-mono truncate">
              evidence: {result.answer.evidence.map((anchor) => anchor.path).join(", ")}
            </div>
          ) : null}
          {coverageConsulted === undefined ? null : (
            <div className="context-map-consulted mt-1.5 text-2xs text-ink-faint">
              {coverageConsulted}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
