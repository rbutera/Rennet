// ─────────────────────────────────────────────────────────────────────────────
// The coach-mark model (C13 · INVENTORY §11 · R55). One mark on screen at a
// time, ever — never a linear N-of-M tour. The store (`./store`) picks the first
// unseen registered mark in system order and shows only that; a surface reads
// lenses → highlight → FAB in sequence, not all at once.
//
// R55 law 10 makes the tour the ONE sanctioned place for explanatory copy in the
// chrome — the "voice split": marks carry a teaching title + one-line body,
// nothing else in the chrome explains or promises. The copy below is that voice
// and is ported verbatim from the reviewed spike.
//
// Marks anchor to chrome only (buttons, switchers, containers) — never to a
// board content element, which is generated and moves.
// ─────────────────────────────────────────────────────────────────────────────
import type { MarkId } from "@rennet/protocol";

/**
 * The closed set of coach marks. Nine per #487 (R55's original eight plus
 * `start-review`, ruled in live at commit fc2ed84e). This union is the anchor
 * key: the typed registry (Cluster 2) is closed over it, so an unknown id is a
 * compile error, not a silent orphan.
 *
 * Defined PROTOCOL-side (`markIdSchema`) and re-exported here — protocol imports no
 * Rennet package, app-ui imports protocol, so the persisted `coachmarks.seen` slice
 * and this mark model share ONE source of truth (Cluster 3). The election order and
 * teaching copy below stay app-side; protocol owns only the validation set.
 */
export type { MarkId } from "@rennet/protocol";

export interface Mark {
  id: MarkId;
  title: string;
  body: string;
  side?: "top" | "bottom" | "left" | "right" | "inline-start" | "inline-end";
  align?: "start" | "center" | "end";
  /** Park the card in the middle of the anchor — for full-region anchors. */
  centered?: boolean;
}

/** System order. Chaining is this order: the first unseen registered mark wins. */
export const MARKS: Mark[] = [
  // First so it outranks the sidebar's Start Here while the indexing CTA shows.
  {
    id: "start-review",
    title: "Ready to Go",
    body: "Click here to start your first review on this project.",
    side: "top",
    align: "center",
  },
  {
    id: "new-chat",
    title: "Start Here",
    body: "Pick a branch or pull request to review. Add Project brings in another repo.",
    side: "inline-end",
    align: "start",
  },
  {
    id: "smart-list",
    title: "One List",
    body: "Your branches and open pull requests, together. Rows marked Needs You are waiting on your review.",
    side: "top",
    align: "center",
  },
  {
    id: "lenses",
    title: "Five Lenses",
    body: "One change, read five ways. Design checks the spec, Sequence orders the read, Decisions and Flagged carry judgment and defects, Noise holds the mechanical.",
    side: "bottom",
    align: "center",
  },
  {
    id: "highlight",
    title: "Highlight to Act",
    body: "Highlight any sentence to comment, ask for an explanation, or request a change.",
    centered: true,
  },
  {
    id: "fab",
    title: "The Way Out",
    body: "Everything you stage lands here: the review you post, or the round you dispatch.",
    side: "top",
    align: "end",
  },
  {
    id: "verdict",
    title: "Verdict",
    body: "Proposed from your review. You decide what posts.",
    side: "bottom",
    align: "start",
  },
  {
    id: "draft",
    title: "The Living Draft",
    body: "The draft reworks itself as you stage and steer. Highlight any of its text to revise or drop it.",
    side: "inline-start",
    align: "start",
  },
  {
    id: "dispatch",
    title: "Dispatch",
    body: "Asks become a work order. Dispatch runs them in a detached worktree and returns a fresh board.",
    side: "inline-end",
    align: "center",
  },
];

export const MARK_BY_ID = Object.fromEntries(MARKS.map((m) => [m.id, m])) as Record<MarkId, Mark>;
