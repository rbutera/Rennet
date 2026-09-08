import type { SmartListCi } from "@rennet/protocol";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rennet/ui";
import {
  type ColumnFiltersState,
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_arrHas,
  globalFilteringFeature,
  type Header,
  rowSortingFeature,
  type SortingState,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleX,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useMemo } from "react";
import { Avatar } from "../components/avatar";
import { Icon } from "../components/icon";
import { filterSmartRows, type SmartFilter, type SmartRow } from "./smart-list";

// ─────────────────────────────────────────────────────────────────────────────
// The New Chat list as a TanStack table. The columns, in the order a reviewer picks:
// the change and its state, who made it, whether CI likes it, how big it is, how old it
// is, how recently it moved. Sorting, the scope rail, the facet filters, and the text
// search all run through the table's own state, so every one of them composes — a search
// inside "Needs you" narrowed to one author is one filtered row model, not three ad-hoc
// passes over the array.
//
// The list folds from the right as the canvas narrows (`@container` on the content
// region; a fold is a class on the column's meta, applied to its head and its cells):
//   ≥ 72rem   change · author · CI · lines · files · created · activity
//   ≥ 54rem   change · author · CI · lines · activity
//   below     change · author (face only) · lines · activity
// Status is not a column: "Review requested" and "Your PR" sit beside the title.
// ─────────────────────────────────────────────────────────────────────────────

/** Cells that exist only from a fold up. */
const FROM_54 = "hidden @[54rem]:table-cell";
const FROM_72 = "hidden @[72rem]:table-cell";

interface ChangeColumnMeta {
  /** Numbers sit flush right so magnitudes line up down the column. */
  readonly align?: "right";
  /** The fold this column appears from; absent means always. */
  readonly fold?: string;
  /** The fold the header's WORD appears from, where the cell itself is always drawn. */
  readonly labelFold?: string;
  /** A column that exists only to be filtered on, never drawn. */
  readonly hidden?: true;
}

export function repoOf(row: SmartRow): string {
  return row.kind === "pr" ? (row.pr?.repository ?? "") : (row.local?.repository ?? "");
}
export function forgeOf(row: SmartRow): string | undefined {
  return row.kind === "pr" ? row.pr?.forgeRepository?.forge : row.local?.forgeRepository?.forge;
}
export function forgeLabel(forge: string): string {
  if (forge === "github") return "GitHub";
  if (forge === "gitlab") return "GitLab";
  if (forge === "bitbucket") return "Bitbucket";
  return forge;
}
function requestPrefix(forge: string | undefined): "#" | "!" {
  return forge === "gitlab" ? "!" : "#";
}
/** Repositories that share an `owner/name` across two forges, so search qualifies them. */
export function repositoriesNeedingForge(rows: readonly SmartRow[]): ReadonlySet<string> {
  const forgesByRepository = new Map<string, Set<string>>();
  for (const row of rows) {
    const forge = forgeOf(row);
    if (!forge) continue;
    const repository = repoOf(row);
    const forges = forgesByRepository.get(repository) ?? new Set<string>();
    forges.add(forge);
    forgesByRepository.set(repository, forges);
  }
  return new Set(
    [...forgesByRepository]
      .filter(([, forges]) => forges.size > 1)
      .map(([repository]) => repository),
  );
}
/** The text search: number, title, branch, repository (forge-qualified where ambiguous), author. */
export function matchesText(
  row: SmartRow,
  needle: string,
  ambiguous: ReadonlySet<string>,
): boolean {
  if (!needle) return true;
  const repository = repoOf(row);
  const forge = forgeOf(row);
  const qualified =
    forge && ambiguous.has(repository) ? `${forgeLabel(forge)} ${repository}` : repository;
  const haystack =
    row.kind === "pr"
      ? `${requestPrefix(forge)}${row.pr?.number} ${row.title} ${row.branch} ${qualified} ${row.author}`
      : `${row.branch} ${qualified} ${row.author}`;
  return haystack.toLowerCase().includes(needle);
}

const DAY_MONTH = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
function formatDate(value: string | undefined): string {
  if (!value) return "—";
  return DAY_MONTH.format(new Date(value));
}
function formatActivity(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
  if (elapsed < day * 2) return "Yesterday";
  return formatDate(value);
}

/** The CI facet's vocabulary: a PR's reported state, or `none` for a row with no checks. */
export type CiFacet = SmartListCi | "none";
export const CI_LABELS: Record<CiFacet, string> = {
  passing: "Passing",
  failing: "Failing",
  pending: "Pending",
  none: "No checks",
};
export function ciOf(row: SmartRow): CiFacet {
  return row.pr?.ci ?? "none";
}

export interface ChangeTableMeta {
  /** The row whose mint is in flight, wearing the starting mark. */
  readonly startingId: string | null;
}

const features = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
  filterFns: { arrHas: filterFn_arrHas },
  columnMeta: {} as ChangeColumnMeta,
  tableMeta: {} as ChangeTableMeta,
});
const helper = createColumnHelper<typeof features, SmartRow>();

/** The rail's scope as a column filter: `all` is no filter at all. */
function scopeFilter(row: { original: SmartRow }, _columnId: string, value: unknown): boolean {
  return filterSmartRows([row.original], value as SmartFilter).length === 1;
}

const columns = helper.columns([
  helper.accessor((row) => row.title, {
    id: "change",
    header: "Change",
    enableSorting: false,
    enableGlobalFilter: true,
    cell: ({ row }) => <ChangeCell row={row.original} />,
  }),
  helper.accessor("author", {
    id: "author",
    header: "Author",
    sortFn: "alphanumeric",
    filterFn: "arrHas",
    enableGlobalFilter: false,
    meta: { labelFold: "hidden @[54rem]:inline" },
    cell: ({ row }) => (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-soft">
        <Avatar name={row.original.author} src={row.original.authorAvatarUrl} />
        <span className="hidden truncate @[54rem]:inline">{row.original.author}</span>
      </span>
    ),
  }),
  helper.accessor((row) => ciOf(row), {
    id: "ci",
    header: "CI",
    enableSorting: false,
    filterFn: "arrHas",
    enableGlobalFilter: false,
    meta: { fold: FROM_54 },
    cell: ({ row }) => <CiStatus ci={row.original.pr?.ci} />,
  }),
  helper.accessor(
    (row) =>
      row.additions === undefined || row.deletions === undefined
        ? undefined
        : row.additions + row.deletions,
    {
      id: "lines",
      header: "Lines",
      sortFn: "basic",
      sortDescFirst: true,
      sortUndefined: "last",
      enableGlobalFilter: false,
      meta: { align: "right" },
      cell: ({ row }) => <LinesCell row={row.original} />,
    },
  ),
  helper.accessor("changedFiles", {
    id: "files",
    header: "Files",
    sortFn: "basic",
    sortDescFirst: true,
    sortUndefined: "last",
    enableGlobalFilter: false,
    meta: { align: "right", fold: FROM_72 },
    cell: ({ getValue }) => {
      const files = getValue();
      return files === undefined ? <Dash /> : <span className="text-ink-soft">{files}</span>;
    },
  }),
  helper.accessor("createdAt", {
    id: "created",
    header: "Created",
    sortFn: "basic",
    sortDescFirst: true,
    sortUndefined: "last",
    enableGlobalFilter: false,
    meta: { fold: FROM_72 },
    cell: ({ getValue }) => {
      const created = getValue();
      return (
        <time dateTime={created} title={created} className="text-ink-soft">
          {formatDate(created)}
        </time>
      );
    },
  }),
  helper.accessor("lastActivityAt", {
    id: "activity",
    header: "Activity",
    sortFn: "basic",
    sortDescFirst: true,
    enableGlobalFilter: false,
    cell: ({ getValue }) => {
      const at = getValue();
      return (
        <time dateTime={at} title={at} className="text-ink-soft">
          {formatActivity(at)}
        </time>
      );
    },
  }),
  helper.display({
    id: "mark",
    header: () => <span className="sr-only">Starting</span>,
    cell: ({ table, row }) => (
      <Icon
        icon={Check}
        data-mark="start"
        className={cn(
          "size-4 text-accent transition-opacity",
          table.options.meta?.startingId === row.original.id ? "opacity-100" : "opacity-0",
        )}
      />
    ),
  }),
  // Filter-only columns: the rail's scope and the repository facet.
  helper.accessor((row) => row.id, {
    id: "scope",
    enableSorting: false,
    enableGlobalFilter: false,
    filterFn: scopeFilter,
    meta: { hidden: true },
  }),
  helper.accessor((row) => repoOf(row), {
    id: "repository",
    enableSorting: false,
    enableGlobalFilter: false,
    filterFn: "arrHas",
    meta: { hidden: true },
  }),
]);

const HIDDEN_COLUMNS = { scope: false, repository: false };

export type ChangeSorting = SortingState;
export type ChangeFilters = ColumnFiltersState;
export const DEFAULT_SORTING: ChangeSorting = [{ id: "activity", desc: true }];

export function useChangeTable({
  rows,
  sorting,
  onSortingChange,
  columnFilters,
  onColumnFiltersChange,
  query,
  startingId,
}: {
  readonly rows: readonly SmartRow[];
  readonly sorting: ChangeSorting;
  readonly onSortingChange: (next: ChangeSorting) => void;
  readonly columnFilters: ChangeFilters;
  readonly onColumnFiltersChange: (next: ChangeFilters) => void;
  readonly query: string;
  readonly startingId: string | null;
}) {
  const ambiguous = useMemo(() => repositoriesNeedingForge(rows), [rows]);
  const needle = query.trim().toLowerCase();
  return useTable({
    features,
    columns,
    data: rows as SmartRow[],
    getRowId: (row) => row.id,
    meta: { startingId },
    state: { sorting, columnFilters, globalFilter: needle, columnVisibility: HIDDEN_COLUMNS },
    onSortingChange: (updater) =>
      onSortingChange(typeof updater === "function" ? updater(sorting) : updater),
    onColumnFiltersChange: (updater) =>
      onColumnFiltersChange(typeof updater === "function" ? updater(columnFilters) : updater),
    enableSortingRemoval: false,
    enableMultiSort: false,
    // The search reads one haystack per row, so it runs once per row rather than once per
    // column: only the change column is asked.
    getColumnCanGlobalFilter: (column) => column.id === "change",
    globalFilterFn: (row, _columnId, value: string) => matchesText(row.original, value, ambiguous),
  });
}
export type ChangeTable = ReturnType<typeof useChangeTable>;

/** Read one column's array filter, or none. */
export function facetValue(filters: ChangeFilters, id: string): readonly string[] {
  const value = filters.find((filter) => filter.id === id)?.value;
  return Array.isArray(value) ? (value as string[]) : [];
}
/** Replace one column's filter; an empty array clears it. */
export function withFacet(
  filters: ChangeFilters,
  id: string,
  value: readonly string[],
): ChangeFilters {
  const rest = filters.filter((filter) => filter.id !== id);
  return value.length === 0 ? rest : [...rest, { id, value: [...value] }];
}
export function scopeOf(filters: ChangeFilters): SmartFilter {
  const value = filters.find((filter) => filter.id === "scope")?.value;
  return typeof value === "string" ? (value as SmartFilter) : "all";
}
export function withScope(filters: ChangeFilters, scope: SmartFilter): ChangeFilters {
  const rest = filters.filter((filter) => filter.id !== "scope");
  return scope === "all" ? rest : [...rest, { id: "scope", value: scope }];
}

export interface FacetOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}
/** Distinct values of `pick` across the rows, most frequent first, with their counts. */
export function facetOptions(
  rows: readonly SmartRow[],
  pick: (row: SmartRow) => string,
  label: (value: string) => string = (value) => value,
): FacetOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = pick(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, label: label(value), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** A facet: a multi-select over one column's distinct values. Drawn only where it can
 *  split the rows — a facet with one option would be chrome explaining itself. */
export function FacetFilter({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly FacetOption[];
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}) {
  if (options.length < 2) return null;
  const selected = new Set(value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="lg" data-facet={label.toLowerCase()} />}
        aria-label={`Filter by ${label.toLowerCase()}`}
      >
        <span>{label}</span>
        {selected.size > 0 ? (
          <span
            data-facet-count
            className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-fill px-1 text-10 font-semibold text-accent-ink tabular-nums"
          >
            {selected.size}
          </span>
        ) : null}
        <Icon icon={ChevronDown} className="size-3.5 text-ink-faint" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selected.has(option.value)}
            closeOnClick={false}
            onCheckedChange={(checked) => {
              const next = new Set(selected);
              if (checked) next.add(option.value);
              else next.delete(option.value);
              onChange([...next]);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <span className="text-xs text-ink-faint tabular-nums">{option.count}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The table itself. Every row is a target: click (or Enter / Space on the focused row)
 * starts the session — it is not a selection you then confirm. `data-row="target"` is the
 * seam the E2E specs and the coach anchor find the rows by.
 */
export function ChangeTable({
  table,
  pending,
  scanning,
  onStart,
  empty,
}: {
  readonly table: ChangeTable;
  /** A mint is in flight somewhere in the list: every row waits. */
  readonly pending: boolean;
  /** The first read has not answered: draw a ghost list under the words. */
  readonly scanning: boolean;
  readonly onStart: (row: SmartRow) => void;
  /** What to say when there is nothing to draw. */
  readonly empty: ReactNode;
}) {
  const rows = table.getRowModel().rows;
  const columnCount = table.getVisibleLeafColumns().length;
  return (
    <Table className="table-auto" containerClassName="overflow-visible">
      {/* The header sticks to the content region's scroller (the only ancestor that
          scrolls); the card clips with `overflow-clip`, which unlike `hidden` is not a
          scroll container and so does not capture the sticky box. */}
      <TableHeader className="sticky top-0 z-10 bg-canvas">
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id} className="border-line hover:bg-transparent">
            {group.headers.map((header) => {
              const meta = header.column.columnDef.meta;
              const sorted = header.column.getIsSorted();
              return (
                <TableHead
                  key={header.id}
                  aria-sort={
                    sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                  }
                  className={cn(
                    meta?.fold,
                    meta?.align === "right" && "text-right",
                    header.column.id === "change" && "w-full",
                  )}
                >
                  {header.column.getCanSort() ? (
                    <SortHeader header={header} meta={meta} />
                  ) : (
                    <table.FlexRender header={header} />
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const target = row.original;
          const starting = table.options.meta?.startingId === target.id && pending;
          return (
            <TableRow
              key={row.id}
              data-row="target"
              data-starting={starting ? "true" : undefined}
              tabIndex={pending ? -1 : 0}
              aria-disabled={pending || undefined}
              onClick={() => {
                if (!pending) onStart(target);
              }}
              onKeyDown={(event: KeyboardEvent<HTMLTableRowElement>) => {
                if (pending) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onStart(target);
                }
              }}
              className={cn(
                "cursor-pointer outline-none hover:bg-raised/60 focus-visible:bg-raised/60 focus-visible:-outline-offset-3",
                pending && "cursor-not-allowed",
                pending && !starting && "opacity-60",
                starting && "bg-secondary/60",
                // Merged is done: it stays legible (the retrospective path reads it) but
                // recedes behind the open work.
                target.state === "merged" && "opacity-70 hover:opacity-100",
              )}
            >
              {row.getVisibleCells().map((cell) => {
                const meta = cell.column.columnDef.meta;
                return (
                  <TableCell
                    key={cell.id}
                    data-column={cell.column.id}
                    className={cn(
                      "py-3 text-xs tabular-nums",
                      meta?.fold,
                      meta?.align === "right" && "text-right",
                      cell.column.id === "change" && "w-full max-w-0",
                      cell.column.id === "mark" && "pr-3.5 pl-0",
                    )}
                  >
                    <table.FlexRender cell={cell} />
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
        {rows.length === 0 && scanning ? <GhostRows columns={columnCount} /> : null}
        {rows.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell
              colSpan={columnCount}
              className="px-4 py-12 text-center text-12-5 text-ink-faint"
            >
              {empty}
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}

function SortHeader({
  header,
  meta,
}: {
  readonly header: Header<typeof features, SmartRow, unknown>;
  readonly meta: ChangeColumnMeta | undefined;
}) {
  const label = String(header.column.columnDef.header);
  const align = meta?.align;
  const sorted = header.column.getIsSorted();
  return (
    <button
      type="button"
      onClick={header.column.getToggleSortingHandler()}
      aria-label={`Sort by ${label.toLowerCase()}`}
      data-sorted={sorted || undefined}
      className={cn(
        "group/sort -mx-1.5 inline-flex h-7 items-center gap-1 rounded-sm px-1.5 uppercase tracking-wide transition-colors hover:text-ink",
        sorted && "text-ink-soft",
        align === "right" && "flex-row-reverse",
      )}
    >
      <span className={meta?.labelFold}>{label}</span>
      <Icon
        icon={sorted === "asc" ? ArrowUp : ArrowDown}
        className={cn(
          "size-3 transition-opacity",
          sorted ? "opacity-100" : "opacity-0 group-hover/sort:opacity-50",
        )}
      />
    </button>
  );
}

/** A ghost of the list while the first read is still scanning: three rows of the
 *  columns' shapes, so the space the answer will take is already held. */
function GhostRows({ columns }: { readonly columns: number }) {
  return (
    <>
      {[0, 1, 2].map((index) => (
        <TableRow key={index} aria-hidden className="hover:bg-transparent">
          <TableCell colSpan={columns} className="py-3">
            <span className="flex items-center gap-3">
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className={cn("h-3.5", index === 1 ? "w-2/5" : "w-1/3")} />
              <Skeleton className="ml-auto h-3 w-12" />
              <Skeleton className="h-3 w-8" />
            </span>
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function Dash() {
  return <span className="text-ink-faint">—</span>;
}

function LinesCell({ row }: { readonly row: SmartRow }) {
  if (row.additions === undefined || row.deletions === undefined) return <Dash />;
  return (
    <span className="whitespace-nowrap">
      <span className="font-medium text-green">+{row.additions.toLocaleString()}</span>{" "}
      <span className="font-medium text-danger">−{row.deletions.toLocaleString()}</span>
    </span>
  );
}

function ChangeCell({ row }: { readonly row: SmartRow }) {
  const merged = row.state === "merged";
  if (row.kind === "local") {
    const local = row.local;
    const ahead = local?.ahead !== null && local?.ahead !== undefined && local.ahead > 0;
    const behind = local?.behind !== null && local?.behind !== undefined && local.behind > 0;
    return (
      <span className="flex min-w-0 items-start gap-2.5">
        <Icon
          icon={GitBranch}
          className={cn("mt-0.5 size-3.5 shrink-0", local?.dirty ? "text-warn" : "text-ink-faint")}
        />
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-2.5">
            <span className="truncate text-sm font-medium text-ink">{row.branch}</span>
            {/* Clean/dirty is a measured fact only where there is a checkout to measure;
                a bare branch says nothing. Dirty is copper (a flag to weigh), not gold. */}
            {local?.worktree ? (
              <span
                data-worktree={local.dirty ? "dirty" : "clean"}
                className={cn(
                  "flex shrink-0 items-center gap-1 text-2xs font-medium",
                  local.dirty ? "text-warn" : "text-green",
                )}
              >
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", local.dirty ? "bg-warn" : "bg-green")}
                />
                {local.dirty ? "dirty" : "clean"}
              </span>
            ) : null}
          </span>
          {ahead || behind ? (
            <span className="mt-0.5 flex gap-2 text-2xs text-ink-faint">
              {ahead ? (
                <span className="inline-flex items-center gap-0.5">
                  <span className="sr-only">{`${local.ahead} ahead`}</span>
                  <span aria-hidden className="contents">
                    <Icon icon={ArrowUp} className="size-2.5" />
                    {local.ahead}
                  </span>
                </span>
              ) : null}
              {behind ? (
                <span className="inline-flex items-center gap-0.5">
                  <span className="sr-only">{`${local.behind} behind`}</span>
                  <span aria-hidden className="contents">
                    <Icon icon={ArrowDown} className="size-2.5" />
                    {local.behind}
                  </span>
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-start gap-2.5">
      <Icon
        icon={merged ? GitMerge : row.pr?.reviewRequested ? GitPullRequestArrow : GitPullRequest}
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          row.pr?.reviewRequested && !merged ? "text-accent" : "text-ink-faint",
        )}
      />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="truncate text-sm font-medium text-ink">{row.title}</span>
          <RowBadge row={row} />
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-2xs text-ink-faint">
          <span className="shrink-0">
            {requestPrefix(row.pr?.forgeRepository?.forge)}
            {row.pr?.number}
          </span>
          {merged ? (
            <span className="flex shrink-0 items-center gap-1 text-ink-soft">
              <Icon icon={GitMerge} className="size-2.5" /> Merged
            </span>
          ) : null}
          <span className="truncate">{row.branch}</span>
          {row.checkedOutLocally ? <span className="shrink-0">checked out locally</span> : null}
        </span>
      </span>
    </span>
  );
}

function RowBadge({ row }: { readonly row: SmartRow }) {
  if (row.kind === "local") return null;
  if (row.state === "merged") return null;
  if (row.pr?.reviewRequested)
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-fill px-2 py-0.5 text-10 font-semibold text-accent-ink">
        <Icon icon={GitPullRequestArrow} className="size-2.5" /> Review requested
      </span>
    );
  if (row.mine)
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-10 font-medium text-ink-soft">
        <Icon icon={GitPullRequest} className="size-2.5" /> Your PR
      </span>
    );
  return null;
}

// CI is a coloured mark AND a named state (the aria-label): DESIGN.md never lets
// colour stand alone. Green passes, red fails, copper is still running; a change
// with no checks at all has nothing to say.
function CiStatus({ ci }: { readonly ci: SmartListCi | undefined }) {
  if (ci === "passing")
    return <Icon icon={CircleCheck} aria-label="CI passing" className="size-4 text-green" />;
  if (ci === "failing")
    return <Icon icon={CircleX} aria-label="CI failing" className="size-4 text-danger" />;
  if (ci === "pending")
    return <Icon icon={CircleDashed} aria-label="CI pending" className="size-4 text-warn" />;
  return <Dash />;
}
