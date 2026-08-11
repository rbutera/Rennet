import type { DispositionType, PrBodyDraftResult } from "@rennet/types";

export type { PrBodyDraftResult };

// ─────────────────────────────────────────────────────────────────────────────
// review.draftPrBody — the PR title/body drafting producer (issue #74, Model
// Council job `pr-body-draft`, light tier, M26).
//
// The own-branch destination's paper (#22) previews a PR submission: title, body,
// base←head. Its body was a deterministic grouping of the dispositions (a diffstat
// in prose). M26 is the light-tier drafting job that writes a title + body that
// reads as an HONEST ACCOUNT of the change, drawn from the reviewed changeset:
//   • the roll-up narration (M22, #70), if one was produced — the whole-changeset
//     account in the review's own voice;
//   • the staged dispositions' resolutions — what the reviewer actually asked for
//     and approved;
//   • the spec angle's requirements — what the change was supposed to satisfy;
//   • the decisions surfaced — the WHY the review discerned.
//
// The draft is a STARTING POINT the human then edits (the collation draft is the
// editable surface, R40; the paper is a freeze). The edited form is what a later,
// separate, explicit create act (#21) would use. This producer NEVER posts,
// pushes, or egresses — it returns text (R33: the preview is pure; create is a
// separate act; Rennet never pushes source).
//
// This is the STRUCTURAL SIBLING of `refine-comment.ts`: a PURE router over an
// injected port. The port owns the ONE real model turn (the live seat is composed
// in apps/desktop, council-routed like every job); this module stays node-free and
// unit-testable with a fake. The honesty invariant it owns: a `drafted` verdict
// whose title OR body is empty is NOT a draft — it is a `failed` turn, so the
// preview keeps its deterministic composed body rather than a blank the human
// might sign unread. A failed/unavailable turn never fabricates a draft.
// ─────────────────────────────────────────────────────────────────────────────

/** One staged disposition, reduced to what the draft reasons over (type + where + the resolution). */
export interface PrBodyDraftDisposition {
  /** The disposition type — a request-change reads differently than an approval. */
  readonly type: DispositionType;
  /** The anchor path the disposition sits on, for the model's orientation. */
  readonly path: string;
  /** The effective body (the refined form once #19 landed, else the raw note). May be empty. */
  readonly resolution: string;
}

/** The whole-changeset account the roll-up narration produced (M22), when present. */
export interface PrBodyDraftNarration {
  readonly oneLine: string;
  readonly paragraph: string;
}

/**
 * Everything the drafter reasons over — the reviewed changeset, reduced to the
 * honest-account inputs. Every enrichment field is optional so the drafter
 * degrades honestly: with only the branch shape and no dispositions it drafts a
 * thin-but-honest submission; each present field makes the account fuller. The
 * branch shape (`base`/`head`) is always present — it frames the submission.
 */
export interface PrBodyDraftInput {
  /** The base branch the PR would target. */
  readonly base: string;
  /** The head branch/ref the PR submits. */
  readonly head: string;
  /** The roll-up narration (M22), when one was produced — the changeset's own voice. */
  readonly narration?: PrBodyDraftNarration;
  /** The staged dispositions' resolutions — what the reviewer asked for and approved. */
  readonly dispositions: readonly PrBodyDraftDisposition[];
  /** The spec angle's requirements — what the change was supposed to satisfy. */
  readonly requirements?: readonly string[];
  /** The decisions surfaced — the WHY the review discerned. */
  readonly decisions?: readonly string[];
}

/**
 * What the injected port returns — the outcome of ONE real model turn. `emitted`
 * carries the model's structured draft (title + body); `unavailable`/`failed` are
 * the two honest degradations (no seat installed / the turn ran and produced no
 * usable structured result). The port NEVER fabricates a success.
 *
 * `model` is the model that ACTUALLY ran, when the port can observe it (e.g. from a
 * session-started frame). Provenance records what wrote the draft, not what the
 * council planned to route to — a seat running its harness default is honest only
 * if it reports that default. When a port cannot observe the runtime model it omits
 * this and the caller falls back to the resolved model.
 */
export type PrBodyDraftPortResult =
  | { readonly status: "emitted"; readonly title?: string; readonly body?: string; readonly model?: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * The drafter port: takes the assembled prompt and runs one real turn. The caller
 * owns the harness wiring (the live Codex/Claude seat, or a fake in tests), so this
 * module never imports an adapter and stays pure.
 */
export type PrBodyDraftPort = (prompt: string) => Promise<PrBodyDraftPortResult>;

/** A stable, human label for a disposition type inside the prompt. */
const TYPE_INTENT: Record<DispositionType, string> = {
  approve: "approved",
  "request-change": "requested change",
  comment: "comment",
  question: "question",
};

/**
 * Assemble the drafter prompt. It is opinionated on the ONE thing that matters:
 * the body must read as an honest account of the CHANGE — what it does and why —
 * grounded in the review's real content (the narration, the dispositions, the
 * requirements, the decisions), never a generic template and never a raw diffstat.
 * The reviewer edits the result, so the prompt asks for a solid starting point, not
 * a final word. Every enrichment section is included only when the input carries it,
 * so the prompt never invites the model to invent content it was not given.
 */
export function buildPrBodyPrompt(input: PrBodyDraftInput): string {
  const lines: string[] = [
    "You are drafting the TITLE and DESCRIPTION for a GitHub pull request, for a developer who will edit it before they open the PR themselves.",
    "",
    "Rules, in order of importance:",
    "1. Write an HONEST ACCOUNT of the change: what it does and why it matters. NEVER a bare list of changed files or a diffstat.",
    "2. Ground every claim in the material below. Do not invent changes, motivations, or scope that is not evidenced here.",
    "3. The title is a single concise line in the imperative mood (e.g. 'Add rate-limit fallback bucket'). No trailing period.",
    "4. The body is Markdown: a short lead paragraph of what changed and why, then the salient points as prose or tight bullets. Reference the real requirements and decisions where they explain the change.",
    "5. This is a STARTING POINT the developer will edit. Be a strong first draft; do not pad, hedge, or add an AI-attribution marker.",
    "",
    `The change submits branch \`${input.head}\` onto \`${input.base}\`.`,
  ];
  if (input.narration !== undefined) {
    lines.push(
      "",
      "The review's roll-up account of the whole changeset:",
      input.narration.oneLine.trim(),
      input.narration.paragraph.trim(),
    );
  }
  const dispositions = input.dispositions.filter((item) => item.resolution.trim() !== "");
  if (dispositions.length > 0) {
    lines.push("", "The reviewer's dispositions on this change (what they asked for and approved):");
    for (const item of dispositions) {
      lines.push(`- [${TYPE_INTENT[item.type]}] ${item.path}: ${item.resolution.trim()}`);
    }
  }
  const requirements = (input.requirements ?? []).filter((line) => line.trim() !== "");
  if (requirements.length > 0) {
    lines.push("", "The requirements this change was meant to satisfy (the spec angle):");
    for (const requirement of requirements) lines.push(`- ${requirement.trim()}`);
  }
  const decisions = (input.decisions ?? []).filter((line) => line.trim() !== "");
  if (decisions.length > 0) {
    lines.push("", "The decisions the review surfaced (the WHY behind the change):");
    for (const decision of decisions) lines.push(`- ${decision.trim()}`);
  }
  lines.push(
    "",
    'Return JSON: {"title":"<the PR title>","body":"<the PR description, Markdown>"}. Both fields are required and must be non-empty.',
  );
  return lines.join("\n");
}

/**
 * Draft a PR title + body from the reviewed changeset via the injected port. Pure
 * and deterministic given its port: it assembles the prompt, runs the one turn, and
 * maps the outcome, enforcing the honesty floor — a `drafted` result the caller
 * previews is always a genuine title AND body, never an empty field dressed as a
 * draft. A failed/unavailable turn returns that state, and the caller keeps the
 * deterministic composed body rather than showing a blank.
 */
export async function draftPrBody(
  input: PrBodyDraftInput,
  port: PrBodyDraftPort,
  model: string,
): Promise<PrBodyDraftResult> {
  const turn = await port(buildPrBodyPrompt(input));
  if (turn.status === "unavailable") return { status: "unavailable", reason: turn.reason };
  if (turn.status === "failed") return { status: "failed", reason: turn.reason };
  // Report the model that ACTUALLY ran when the port observed it; else the resolved
  // model. A seat running its harness default must not claim the council's planned
  // pick — that is a provenance lie about who wrote the draft.
  const reportedModel = turn.model ?? model;
  const title = (turn.title ?? "").trim();
  const body = (turn.body ?? "").trim();
  // The honesty floor: a draft needs BOTH a title and a body. An empty either way is
  // not a draft — it is a failed turn, so the preview keeps its deterministic body.
  if (title === "" || body === "") {
    return { status: "failed", reason: "the drafter returned an empty title or body" };
  }
  return { status: "drafted", title, body, model: reportedModel };
}
