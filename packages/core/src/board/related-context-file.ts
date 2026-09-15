/**
 * `related-context.md` — the issues and pull requests the HOST already fetched for this
 * branch, as a context file the Design seat is pointed at (design-overview-fallback D2).
 *
 * Related-context retrieval runs fire-and-forget when a review opens: it extracts refs
 * from the branch name, the commit messages and the pull request paper, fetches them
 * through `gh` or the configured tracker's endpoint, and stores a bounded dossier. Until
 * now nothing on the board path read that record. When the Design seat is about to open
 * WITHOUT a located specification, those items are the nearest thing the branch has to a
 * statement of intent — so they travel to the one seat that can use them, as a file.
 *
 * A file, not an interpolation: the seat reads only the items it decides it needs, which
 * is the progressive-disclosure rule every other context file follows. The bodies are
 * already bounded by the dossier schema; the bounds here are the file's own, declared at
 * the call site, so a pathological branch cannot produce a file no seat can read.
 *
 * Two builders, ONE name. `relatedContextFile` renders the stored dossier.
 * `relatedContextRefsFile` renders the deterministically extracted refs for the case
 * where retrieval had not settled by the lane's ceiling — the seat reads one path either
 * way, and the file itself says which of the two it is.
 */

import type { DossierItem } from "@rennet/protocol";
import type { SessionContextFile } from "../session-context";

/** The one name related context is written and read under, per session. */
export const RELATED_CONTEXT_FILE = "related-context.md";

/**
 * The most items the file renders, declared at the one call site that renders it.
 *
 * The dossier bounds only its serialized TOTAL (`serializeDossier` drops whole items
 * until the JSON fits `DOSSIER_TOTAL_MAX_CHARS`); retrieval caps no count, so a branch
 * whose refs are all one-liners can store far more than twenty items. This is the file's
 * own bound, and past it the file says how many items it dropped instead of trailing off.
 */
export const RELATED_CONTEXT_MAX_ITEMS = 20;

/**
 * The whole-file byte bound — the dossier's own `DOSSIER_TOTAL_MAX_CHARS`, 64 KiB.
 *
 * A file is not billed the way a prompt is, so this is not a token budget. It is the
 * bound that keeps twenty 16 KiB bodies from producing a quarter-megabyte file the seat
 * would have to read past to find anything.
 */
export const RELATED_CONTEXT_MAX_BYTES = 65_536;

/** The marker a truncated file ends on. `N` is the number of items not listed. */
export const RELATED_CONTEXT_TRUNCATION = "… truncated, ";

/**
 * One extracted reference, in the shape the refs file renders.
 *
 * Deliberately NOT `ExtractedRef` from `@rennet/adapters`: core cannot import adapters,
 * and the file needs three facts, not the extractor's discriminated union. The server
 * maps into this on its way to the builder.
 */
export interface RelatedRef {
  /** How the ref reads on the page: `owner/repo#12`, `#12`, `ABC-123`. */
  readonly label: string;
  /** Absent for a tracker key with no resolved endpoint — stated as such, not faked. */
  readonly url?: string;
  /** Where the ref was found: `branch-name`, `commit-message`, `pr-body`. */
  readonly provenance: string;
}

export interface RelatedContextOptions {
  /** Default {@link RELATED_CONTEXT_MAX_ITEMS}. */
  readonly maxItems?: number;
  /** Default {@link RELATED_CONTEXT_MAX_BYTES}. */
  readonly maxBytes?: number;
}

const ENCODER = new TextEncoder();

function utf8Bytes(text: string): number {
  return ENCODER.encode(text).length;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `… truncated, 3 more items not listed.` */
function truncationLine(dropped: number): string {
  return `${RELATED_CONTEXT_TRUNCATION}${plural(dropped, "more item")} not listed.\n`;
}

/** One item's whole region. Never cut: an item is kept entire or dropped entire. */
function region(item: DossierItem): string {
  const lines = [
    `## ${item.id} — ${item.title}`,
    "",
    `- Tracker: ${item.tracker}`,
    `- State: ${item.state}`,
    `- URL: ${item.url === "" ? "none recorded" : item.url}`,
    `- Found via: ${item.provenance}`,
    `- Fetched: ${item.fetchedAt}`,
    "",
    item.body.trim() === "" ? "_The tracker item has no body._" : item.body.trim(),
    "",
  ];
  const criteria = item.acceptanceCriteria?.trim() ?? "";
  if (criteria !== "") {
    lines.push("### Acceptance criteria", "", criteria, "");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The stored dossier as a context file, or `undefined` when there are no items —
 * following `prPaperContextFile` and `designSourcesContextFile`: a prompt must never name
 * a file that was not written, and an empty file claims there was something to read.
 *
 * Pure and deterministic: the same items always render the same bytes. Items are rendered
 * in DOSSIER ORDER (the caller's order — `serializeDossier` already sorts by id, and
 * re-sorting here would hide a caller that did not).
 */
export function relatedContextFile(
  items: readonly DossierItem[],
  options: RelatedContextOptions = {},
): SessionContextFile | undefined {
  const first = items[0];
  if (first === undefined) return undefined;
  const maxItems = options.maxItems ?? RELATED_CONTEXT_MAX_ITEMS;
  const maxBytes = options.maxBytes ?? RELATED_CONTEXT_MAX_BYTES;

  const header = [
    "# Related issues and pull requests",
    "",
    "The host extracted these references from this branch's name, its commit messages and",
    "the pull request's title and body, then fetched them from the project's tracker (first",
    `fetched ${first.fetchedAt}). They are the reporter's and the author's words, not a`,
    "specification: each one is a STATED INTENT with a tracker id you can cite.",
    "",
    "Quote them verbatim when you use them, and cite the item by its id. Where an item has",
    "no body below, you may fetch it yourself — `gh issue view <n>` / `gh pr view <n>` for a",
    "GitHub ref.",
    "",
  ];

  // The header is outside the bound, as `changeIndexContextFile`'s is: the file says what
  // it is even when nothing else fits. Items are what the bound governs.
  const prefix = `${header.join("\n")}\n`;
  let body = prefix;
  let used = utf8Bytes(prefix);
  let kept = 0;
  const shown = items.slice(0, maxItems);
  for (const [index, item] of shown.entries()) {
    const text = region(item);
    // The marker has to fit beside the region that would displace it, so the file can
    // always account for what it dropped rather than ending mid-change — but only while
    // something is still waiting behind this candidate. The last item displaces nothing
    // and prints no marker, so charging it for one drops an item that fits exactly.
    const behind = items.length - index - 1;
    const reserved = behind > 0 ? utf8Bytes(truncationLine(behind)) : 0;
    if (used + utf8Bytes(text) + reserved > maxBytes) break;
    body += text;
    used += utf8Bytes(text);
    kept += 1;
  }

  const dropped = items.length - kept;
  if (dropped > 0) body += truncationLine(dropped);

  return {
    name: RELATED_CONTEXT_FILE,
    body,
    holds:
      "The issues and pull requests the host found linked to this branch, from the project's tracker.",
    readWhen:
      "when there is no specification and you are drafting the overview; each item is a stated intent with its tracker id.",
  };
}

/**
 * The extracted refs as a context file, for the case where retrieval had not settled by
 * the Design lane's ceiling — same name, so the seat reads one path either way.
 *
 * Zero cost and no egress: these are the refs the extractor already found in text the
 * host already had. The file says so in its first line, because a seat that reads a list
 * of bare ids without knowing the titles are missing would take the list for the whole
 * answer.
 *
 * `undefined` when no ref was extracted.
 *
 * Bounded by count AND by bytes, exactly as `relatedContextFile` is: an item cap alone
 * bounds nothing when the labels are long, and a ref list is the one part of this file
 * that grows with the branch.
 */
export function relatedContextRefsFile(
  refs: readonly RelatedRef[],
  maxItems: number = RELATED_CONTEXT_MAX_ITEMS,
  maxBytes: number = RELATED_CONTEXT_MAX_BYTES,
): SessionContextFile | undefined {
  if (refs.length === 0) return undefined;
  const capped = refs.slice(0, maxItems);
  const header = [
    "# Related issues and pull requests",
    "",
    "Related-context retrieval had NOT finished when this seat opened, so what follows is",
    "only the references the host extracted from this branch's name, its commit messages and",
    "the pull request's title and body — no titles, no bodies, no state.",
    "",
    "You may fetch a GitHub ref yourself: `gh issue view <n>` or `gh pr view <n>` (add",
    "`--repo <owner>/<name>` when the ref names a repository other than this one). A tracker",
    "key with no URL below is not reachable from here; say so rather than guessing at it.",
    "",
  ];

  // Same bound, same shape as above: whole lines only, and the marker is reserved while
  // a ref is still waiting behind the candidate. The header is outside the bound.
  const prefix = `${header.join("\n")}\n`;
  let body = prefix;
  let used = utf8Bytes(prefix);
  let kept = 0;
  for (const [index, ref] of capped.entries()) {
    const line = `- ${ref.label} — ${ref.url ?? "no URL resolved"} — found via ${ref.provenance}\n`;
    const behind = refs.length - index - 1;
    const reserved = behind > 0 ? utf8Bytes(truncationLine(behind)) : 0;
    if (used + utf8Bytes(line) + reserved > maxBytes) break;
    body += line;
    used += utf8Bytes(line);
    kept += 1;
  }

  const dropped = refs.length - kept;
  if (dropped > 0) body += truncationLine(dropped);

  return {
    name: RELATED_CONTEXT_FILE,
    body,
    holds:
      "The issue and pull request references the host extracted from this branch; retrieval had not finished, so there are no titles or bodies.",
    readWhen:
      "when there is no specification and you are drafting the overview; each ref is a pointer you may fetch yourself.",
  };
}
