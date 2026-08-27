import { LENS_KINDS, type LensKind } from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// The #480 route table + URL grammar (C01 §4.2). Pure, React-free helpers: route
// path builders, and the typed read/write of the session query grammar
// (?view/?lens/?file/?project). An unknown ?view or ?lens FALLS BACK to the board
// default / first lens rather than erroring; view and lens toggles navigate with
// `replace` (they refine the same location), while opening a screen `push`es.
// ─────────────────────────────────────────────────────────────────────────────

/** The board view a session route can show (#480/#489). `board` is the default; the
 *  others are explicit `?view=` alternatives. */
export type ViewKind = "board" | "diff" | "map" | "handoff" | "rounds";
export const VIEW_KINDS: readonly ViewKind[] = ["board", "diff", "map", "handoff", "rounds"];
/** The board default view — an unknown or absent ?view falls back here, and it alone is
 *  omitted from a serialized query (diff/map/handoff/rounds always serialize). */
export const DEFAULT_VIEW: ViewKind = "board";
/** The default lens — an unknown ?lens falls back to the first available (else this). */
export const DEFAULT_LENS: LensKind = LENS_KINDS[0];

/** The #480 route patterns (wouter path syntax), plus the two interim routes
 *  (reconciliation 2 — NOT part of the documented #480 grammar). */
export const ROUTES = {
  home: "/",
  newChat: "/new-chat",
  session: "/s/:slug",
  sessionRun: "/s/:slug/run",
  archived: "/archived",
  projectIndexing: "/projects/:id/indexing",
  projectMap: "/projects/:id/map",
  settings: "/settings/:page",
  // Interim (reconciliation 2): the front-door project list and project detail have
  // no #480 row. They mount here so they stay reachable; their permanent addresses
  // are settled by the changes that rebuild them (C12 / C3).
  projects: "/projects",
  projectDetail: "/projects/:id",
} as const;

export interface SessionQuery {
  readonly view?: ViewKind;
  readonly lens?: LensKind;
  readonly file?: string;
  /** The round's diff identity (its generation id) — set on the ledger's Round-diff link so
   *  `?view=diff` resolves the round's IMMUTABLE diff, not whatever `activePatchsetId` points
   *  at now (finding 2). Absent ⇒ the live review diff. */
  readonly round?: string;
}

function queryString(entries: Array<[string, string | undefined]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined) params.set(key, value);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** `/s/:slug` with a canonical, minimal query (default view/lens are omitted). */
export function sessionPath(slug: string, query: SessionQuery = {}): string {
  return `/s/${encodeURIComponent(slug)}${queryString([
    ["view", query.view && query.view !== DEFAULT_VIEW ? query.view : undefined],
    ["lens", query.lens && query.lens !== DEFAULT_LENS ? query.lens : undefined],
    ["file", query.file],
    ["round", query.round],
  ])}`;
}

export function sessionRunPath(slug: string): string {
  return `/s/${encodeURIComponent(slug)}/run`;
}

export function newChatPath(project?: string, ask?: string): string {
  return `/new-chat${queryString([
    ["project", project],
    ["ask", ask],
  ])}`;
}

export function settingsPath(page: string, project?: string): string {
  return `/settings/${encodeURIComponent(page)}${queryString([["project", project]])}`;
}

export function projectDetailPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}`;
}

export function projectSettingsPath(id: string): string {
  return settingsPath("projects", id);
}

export function archivedPath(): string {
  return ROUTES.archived;
}

export function projectMapPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}/map`;
}

export function projectIndexingPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}/indexing`;
}

// ── Query grammar: parse with fallback ───────────────────────────────────────

/** Parse ?view; an unknown or absent value falls back to the board default. */
export function parseView(raw: string | null | undefined): ViewKind {
  return VIEW_KINDS.includes(raw as ViewKind) ? (raw as ViewKind) : DEFAULT_VIEW;
}

/** Parse ?lens against the available lenses; an unknown or absent value falls back to
 *  the first available lens (else the global default). */
export function parseLens(
  raw: string | null | undefined,
  available: readonly LensKind[] = LENS_KINDS,
): LensKind {
  if (raw != null && available.includes(raw as LensKind)) return raw as LensKind;
  return available[0] ?? DEFAULT_LENS;
}

export interface ParsedSessionQuery {
  readonly view: ViewKind;
  readonly lens: LensKind;
  readonly file: string | null;
  /** The requested round's diff identity (its generation id), or null for the live diff. */
  readonly round: string | null;
}

/** Read the whole session query grammar with fallbacks applied. */
export function readSessionQuery(
  search: URLSearchParams,
  availableLenses: readonly LensKind[] = LENS_KINDS,
): ParsedSessionQuery {
  return {
    view: parseView(search.get("view")),
    lens: parseLens(search.get("lens"), availableLenses),
    file: search.get("file"),
    round: search.get("round"),
  };
}

// ── Navigation intents: path + push/replace ──────────────────────────────────

export interface Navigation {
  readonly path: string;
  /** true ⇒ replace the history entry (a same-location refinement); false ⇒ push. */
  readonly replace: boolean;
}

/** A view toggle refines the current session location — REPLACE (no new back-stack entry). */
export function viewToggle(slug: string, view: ViewKind, current: SessionQuery = {}): Navigation {
  return { path: sessionPath(slug, { ...current, view }), replace: true };
}

/** A lens toggle refines the current session location — REPLACE. */
export function lensToggle(slug: string, lens: LensKind, current: SessionQuery = {}): Navigation {
  return { path: sessionPath(slug, { ...current, lens }), replace: true };
}

/** Opening a session is a screen change — PUSH. */
export function openSession(slug: string, query: SessionQuery = {}): Navigation {
  return { path: sessionPath(slug, query), replace: false };
}

/** Opening settings is a screen change — PUSH. */
export function openSettings(page: string, project?: string): Navigation {
  return { path: settingsPath(page, project), replace: false };
}
