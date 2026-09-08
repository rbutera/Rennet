import type { ProjectDetail } from "@rennet/protocol";
import { Button, cn, Kbd, Switch, Toggle, ToggleGroup } from "@rennet/ui";
import {
  ArrowLeft,
  ChevronRight,
  CircleDashed,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useCoachAnchor } from "../coach/registry";
import { Icon } from "../components/icon";
import { useCommand, useRefreshCommand } from "../data";
import { newChatPath } from "../routes/url";
import { usePriorSurface } from "../settings/prior-surface";
import { ProjectPicker } from "../settings/projects/project-picker";
import { useSidebarTree } from "../shell/sidebar-data";
import { hideClaimedRows, useClaimedTargets, useNewChatMint } from "./new-chat-mint";
import {
  type ChangeFilters,
  type ChangeSorting,
  ChangeTable,
  CI_LABELS,
  ciOf,
  DEFAULT_SORTING,
  FacetFilter,
  facetOptions,
  facetValue,
  forgeLabel,
  repoOf,
  scopeOf,
  useChangeTable,
  withFacet,
  withScope,
} from "./new-chat-table";
import { buildSmartRows, type SmartFilter, smartListCounts } from "./smart-list";

const FILTERS: readonly { readonly filter: SmartFilter; readonly label: string }[] = [
  { filter: "all", label: "All changes" },
  { filter: "needs-you", label: "Needs you" },
  { filter: "mine", label: "Yours" },
  { filter: "local", label: "Local branches" },
  { filter: "prs", label: "Pull requests" },
];

/** An Escape that a popup (a menu, the project picker) is already answering is not ours. */
function insidePopup(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      '[role="menu"], [role="dialog"], [role="listbox"], [data-slot="popover-content"]',
    ) !== null
  );
}

export function NewChatView({ projectId }: { readonly projectId: string }) {
  const [, navigate] = useLocation();
  const priorSurface = usePriorSurface();
  const { data: projectsData } = useCommand("projects.list", {});
  const project = projectsData?.projects.find((candidate) => candidate.id === projectId);
  const { hosts } = useSidebarTree();
  const [query, setQuery] = useState("");
  const [showMerged, setShowMerged] = useState(false);
  const [sorting, setSorting] = useState<ChangeSorting>(DEFAULT_SORTING);
  const [columnFilters, setColumnFilters] = useState<ChangeFilters>([]);
  const [starting, setStarting] = useState<string | null>(null);
  const mint = useNewChatMint(projectId);
  const claimed = useClaimedTargets(projectId);
  const refresh = useRefreshCommand("project.detail");
  const {
    data: fetched,
    pending,
    fetching,
    error,
  } = useCommand("project.detail", {
    projectId,
    prStates: showMerged ? ["open", "merged"] : ["open"],
  });
  // The merged toggle is a DIFFERENT query (its own cache key), so `fetched` is empty
  // while the merged pages load — ~2 s a page on GitHub, up to five pages, so ten seconds
  // or more on a repository with history. Flipping the switch used to replace every row
  // on screen with a scanning line for that long, which read as the toggle not working.
  // The last detail that arrived for this project is held and stays on screen; the
  // merged rows join it when they land, and the list says so meanwhile.
  const [held, setHeld] = useState<{ projectId: string; detail: ProjectDetail }>();
  useEffect(() => {
    if (fetched) setHeld({ projectId, detail: fetched });
  }, [fetched, projectId]);
  const detail = fetched ?? (held?.projectId === projectId ? held.detail : undefined);
  // `scanning` is the FIRST load of this project's branches and change requests, and it
  // is load-bearing for the empty-state copy below (#872): `rows` is `[]` until `detail`
  // arrives, and on a network clone that scan runs for minutes, during which the list
  // read "no open branches or change requests yet" — honest-empty wording for a state
  // that was actually still scanning.
  const scanning = pending && detail === undefined;
  const loadingMerged = pending && detail !== undefined && showMerged;
  const errorMessage = error ? String((error as Error)?.message ?? error) : undefined;

  useEffect(() => {
    if (!mint.pending) setStarting(null);
  }, [mint.pending]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || insidePopup(event.target)) return;
      navigate(priorSurface());
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, priorSurface]);

  const rows = useMemo(() => {
    if (!detail) return [];
    const visibleDetail = showMerged
      ? detail
      : { ...detail, prs: detail.prs.filter((pr) => pr.state !== "merged") };
    return buildSmartRows(visibleDetail);
  }, [detail, showMerged]);
  const unclaimed = useMemo(() => hideClaimedRows(rows, claimed), [claimed, rows]);
  const counts = useMemo(() => smartListCounts(unclaimed), [unclaimed]);
  // The facets offer what the rows actually hold, counted before any filter applies, so
  // a reviewer can see what else is there from inside a narrowed list.
  const authorOptions = useMemo(() => facetOptions(unclaimed, (row) => row.author), [unclaimed]);
  const ciOptions = useMemo(
    () => facetOptions(unclaimed, ciOf, (value) => CI_LABELS[value as keyof typeof CI_LABELS]),
    [unclaimed],
  );
  const repoOptions = useMemo(() => facetOptions(unclaimed, repoOf), [unclaimed]);

  const table = useChangeTable({
    rows: unclaimed,
    sorting,
    onSortingChange: setSorting,
    columnFilters,
    onColumnFiltersChange: setColumnFilters,
    query,
    startingId: mint.pending ? starting : null,
  });
  const activeFilter = scopeOf(columnFilters);
  const shown = table.getRowModel().rows.length;
  const narrowed = shown !== unclaimed.length;
  const clearFilters = () => {
    setColumnFilters([]);
    setQuery("");
  };
  const smartListRef = useCoachAnchor("smart-list");

  return (
    <section
      data-screen="new-chat"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-canvas"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <button
          type="button"
          onClick={() => navigate(priorSurface())}
          aria-label="Back"
          className="flex size-6 items-center justify-center rounded-control text-ink-faint hover:bg-raised hover:text-ink"
        >
          <Icon icon={ArrowLeft} className="size-3.5" />
        </button>
        <span className="flex min-w-0 items-center gap-1.5 text-13">
          <span className="shrink-0 text-ink-soft">{project?.name ?? projectId}</span>
          <Icon icon={ChevronRight} className="size-2.5 shrink-0 text-muted-foreground/50" />
          <span className="font-medium text-ink">New Chat</span>
        </span>
        <Kbd className="ml-auto text-ink-faint">esc</Kbd>
      </header>
      {/* The content region is the measure for every fold below (`@container`): the
          canvas narrows with the sidebar and the chat column, not only with the window. */}
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1380px] flex-col px-4 pt-[4vh] pb-10 @[48rem]:px-8 @[48rem]:pt-[6vh]">
          <h1 className="flex flex-wrap items-baseline justify-center gap-2.5 text-center font-display text-xl font-semibold tracking-tight text-ink @[48rem]:text-2xl">
            What should we review in
            <ProjectPicker
              large
              hosts={hosts}
              value={projectId}
              onChange={(next) => navigate(newChatPath(next))}
            />
            ?
          </h1>
          {detail?.forgeUnavailable?.map((unavailable) => (
            <p
              key={`${unavailable.repository.forge}:${unavailable.repository.owner}/${unavailable.repository.name}`}
              className="mt-5 flex items-center gap-2 rounded-chip border border-accent-line bg-accent-surface px-3.5 py-2.5 text-sm text-ink"
              role="note"
            >
              <Icon icon={TriangleAlert} className="size-3.5 shrink-0" />
              <span>
                {unavailable.repository.owner}/{unavailable.repository.name} could not load from{" "}
                {forgeLabel(unavailable.repository.forge)}: {unavailable.repair}
              </span>
            </p>
          ))}
          {errorMessage ? (
            <p
              role="alert"
              className="mt-5 flex items-center gap-2 rounded-chip border border-danger bg-danger-soft px-3.5 py-2.5 text-sm text-ink"
            >
              <Icon icon={TriangleAlert} className="size-3.5 shrink-0 text-danger" />
              <span>
                Could not load this project's change requests: {errorMessage}
                {detail ? " The rows below are from the last read that answered." : ""}
              </span>
            </p>
          ) : null}
          {/* The toolbar: the search takes the width; the facets and the refresh sit at
              its end. Below 48rem the facets wrap under the search. */}
          <div className="mt-6 flex flex-wrap items-center gap-2 @[48rem]:mt-8">
            <label className="flex h-9 min-w-0 flex-1 basis-64 items-center gap-2 rounded-lg border border-line bg-card/25 px-3 transition-colors focus-within:border-accent-line">
              <Icon icon={Search} className="size-4 shrink-0 text-ink-faint" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
                placeholder="Search branches, PRs, authors…"
                aria-label="Search branches, pull requests, and authors"
                className="w-full min-w-0 bg-transparent text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-faint hover:bg-raised hover:text-ink"
                >
                  <Icon icon={X} className="size-3.5" />
                </button>
              ) : null}
            </label>
            <div className="flex items-center gap-2">
              <FacetFilter
                label="Author"
                options={authorOptions}
                value={facetValue(columnFilters, "author")}
                onChange={(next) => setColumnFilters(withFacet(columnFilters, "author", next))}
              />
              <FacetFilter
                label="CI"
                options={ciOptions}
                value={facetValue(columnFilters, "ci")}
                onChange={(next) => setColumnFilters(withFacet(columnFilters, "ci", next))}
              />
              <FacetFilter
                label="Repository"
                options={repoOptions}
                value={facetValue(columnFilters, "repository")}
                onChange={(next) => setColumnFilters(withFacet(columnFilters, "repository", next))}
              />
              <Button
                variant="outline"
                size="lg"
                onClick={refresh}
                disabled={fetching}
                aria-label={fetching ? "Refreshing" : "Refresh branches and pull requests"}
                data-refresh={fetching ? "refreshing" : "idle"}
              >
                <Icon
                  icon={RefreshCw}
                  data-icon="inline-start"
                  className={cn("size-3.5", fetching && "animate-spin motion-reduce:animate-none")}
                />
                <span className="hidden @[48rem]:inline">Refresh</span>
              </Button>
            </div>
          </div>
          {/* Below 64rem the rail folds into a row above the table: the filters as a
              tray, the merged switch beside it. */}
          <div className="mt-4 flex min-h-0 flex-col items-stretch gap-3 @[64rem]:flex-row @[64rem]:items-start @[64rem]:gap-4">
            <aside className="flex shrink-0 flex-col-reverse gap-2 @[64rem]:w-60 @[64rem]:flex-col @[64rem]:gap-0 @[64rem]:overflow-hidden @[64rem]:rounded-lg @[64rem]:border @[64rem]:border-line @[64rem]:bg-card/25">
              <div className="flex items-center justify-end gap-3 px-1 @[64rem]:justify-between @[64rem]:border-b @[64rem]:border-line @[64rem]:px-3.5 @[64rem]:py-3">
                <label htmlFor="show-merged" className="text-12-5 font-medium text-ink-soft">
                  Show merged PRs
                </label>
                <Switch
                  id="show-merged"
                  size="sm"
                  checked={showMerged}
                  onCheckedChange={setShowMerged}
                />
              </div>
              <ToggleGroup
                value={[activeFilter]}
                onValueChange={(next: string[]) => {
                  if (next[0]) setColumnFilters(withScope(columnFilters, next[0] as SmartFilter));
                }}
                aria-label="Filter review targets"
                className="flex w-full flex-row flex-wrap items-stretch gap-1 rounded-lg border border-line bg-card/25 p-1.5 @[64rem]:flex-col @[64rem]:gap-0.5 @[64rem]:rounded-none @[64rem]:border-0 @[64rem]:bg-transparent @[64rem]:p-2"
              >
                {FILTERS.map(({ filter, label }) => (
                  <Toggle
                    key={filter}
                    value={filter}
                    size="sm"
                    className="justify-between gap-2 px-2.5 @[64rem]:w-full"
                  >
                    <span>{label}</span>
                    <span
                      className={cn(
                        "text-10 tabular-nums",
                        activeFilter === filter ? "text-ink-soft" : "text-ink-faint",
                      )}
                    >
                      {counts[filter]}
                    </span>
                  </Toggle>
                ))}
              </ToggleGroup>
            </aside>
            <div
              ref={smartListRef}
              aria-busy={fetching || undefined}
              className="min-w-0 flex-1 overflow-clip rounded-lg border border-line bg-card/25"
            >
              {loadingMerged ? (
                <p
                  role="status"
                  className="flex items-center gap-2 border-b border-line px-4 py-2 text-12-5 text-ink-faint"
                >
                  <Icon
                    icon={CircleDashed}
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                  />
                  loading merged pull requests…
                </p>
              ) : null}
              <ChangeTable
                table={table}
                pending={mint.pending}
                scanning={scanning}
                onStart={(row) => {
                  setStarting(row.id);
                  mint.start(row, "");
                }}
                empty={
                  scanning
                    ? "scanning this project's branches and change requests…"
                    : unclaimed.length === 0
                      ? errorMessage
                        ? "nothing could be loaded"
                        : "no open branches or change requests yet"
                      : "nothing matches"
                }
              />
              {narrowed ? (
                <p
                  data-result-count
                  className="flex items-center justify-between gap-3 border-t border-line px-4 py-2 text-12-5 text-ink-faint tabular-nums"
                >
                  <span>
                    {shown} of {unclaimed.length}
                  </span>
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="rounded-sm text-ink-soft underline-offset-4 hover:text-ink hover:underline"
                  >
                    Clear filters
                  </button>
                </p>
              ) : null}
            </div>
          </div>
          {mint.error ? (
            <p role="alert" className="mt-3 text-center text-xs text-danger">
              Could not start a session: {String((mint.error as Error)?.message ?? mint.error)}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
