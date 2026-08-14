// @vitest-environment happy-dom
//
// The "what was sent" inspector (issue #30): it renders the ContextManifest — the
// documents assembled for a fleet dispatch, in SENT ORDER, with hashes, byte counts,
// and truncated/dropped state — plus the assembled-prompt digest. It is deterministic,
// model-free, and gate-free: it shows the truth, it never gates what may be sent.
import type { ContextDocumentRecord, ContextManifest } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { ContextManifestPanel } from "./context-manifest-panel";

const CLAUDE_REC: ContextDocumentRecord = {
  order: 0,
  source: "claude-md",
  sourcePath: "CLAUDE.md",
  contentHash: "a".repeat(64),
  originalBytes: 120,
  bytes: 120,
  state: "included",
};
const AGENTS_REC: ContextDocumentRecord = {
  order: 1,
  source: "agents-md",
  sourcePath: "AGENTS.md",
  contentHash: "b".repeat(64),
  originalBytes: 300,
  bytes: 64,
  state: "truncated",
};
const MAP_REC: ContextDocumentRecord = {
  order: 2,
  source: "project-map",
  sourcePath: "(project-map)",
  contentHash: "c".repeat(64),
  originalBytes: 500,
  bytes: 0,
  state: "dropped",
};

const manifest: ContextManifest = {
  repoRecordId: "/repo",
  projectSnapshotId: "fp-1",
  compositionDigest: "comp-1",
  freshness: { status: "current", staleMembers: [] },
  members: [],
  documents: [CLAUDE_REC, AGENTS_REC, MAP_REC],
  totalBytes: 184,
  assembledPromptDigest: "d".repeat(64),
  exhaustive: false,
  unmanagedSources: ["harness ambient file reads (context-isolation probe not yet run)"],
};

describe("ContextManifestPanel (#30)", () => {
  it("renders documents in SENT order with truncation/drop marked", () => {
    // Deliberately pass the documents out of order — the panel must sort by `order`.
    const shuffled: ContextManifest = {
      ...manifest,
      documents: [MAP_REC, CLAUDE_REC, AGENTS_REC],
    };
    const { container } = mount(<ContextManifestPanel manifest={shuffled} />);
    const rows = [...container.querySelectorAll('[data-testid="context-manifest-doc"]')];
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual([
      "included",
      "truncated",
      "dropped",
    ]);
    // The paths render in sent order, not the array order they were passed in.
    const paths = [...container.querySelectorAll(".context-manifest-path")].map(
      (el) => el.textContent,
    );
    expect(paths).toEqual(["CLAUDE.md", "AGENTS.md", "(project-map)"]);
    // Truncation is visible with byte counts (never a silent cut).
    expect(container.textContent).toContain("64 of 300 B");
    expect(container.textContent).toContain("0 of 500 B");
  });

  it("shows nothing absent from the manifest: every rendered fact traces to a record", () => {
    const { container } = mount(<ContextManifestPanel manifest={manifest} />);
    const sources = new Set(manifest.documents.map((d) => d.source));
    for (const el of container.querySelectorAll(".context-manifest-source")) {
      const label = el.getAttribute("data-source") ?? "";
      expect(sources.has(label)).toBe(true);
    }
    // Exhaustiveness is honest: not-exhaustive names the unmanaged sources.
    const unmanaged = container.querySelector('[data-testid="context-manifest-unmanaged"]');
    expect(unmanaged?.textContent).toContain("Not exhaustive");
    expect(unmanaged?.textContent).toContain("harness ambient file reads");
  });

  it("shows the assembled-prompt digest and the byte-identical prompt when provided", () => {
    // The prompt text whose digest the manifest recorded; the panel shows it verbatim.
    const { container } = mount(
      <ContextManifestPanel manifest={manifest} assembledPrompt="### claude-md — CLAUDE.md\nfoo" />,
    );
    const digest = container.querySelector('[data-testid="context-manifest-assembled-digest"]');
    // The digest shown is the manifest's recorded digest (byte-identity anchor).
    expect(digest?.getAttribute("title")).toBe(manifest.assembledPromptDigest);
    const prompt = container.querySelector('[data-testid="context-manifest-assembled-prompt"]');
    expect(prompt?.textContent).toContain("### claude-md — CLAUDE.md");
  });

  it("gates NOTHING: no accept / trust / consent affordance anywhere (Rule Zero)", () => {
    const { container } = mount(<ContextManifestPanel manifest={manifest} />);
    const text = (container.textContent ?? "").toLowerCase();
    for (const forbidden of ["accept", "trust", "consent", "approve", "are you sure"]) {
      expect(text).not.toContain(forbidden);
    }
    // No form control that could gate: the only interactive element is the optional
    // "open the assembled prompt" reveal, and it is absent unless a handler is given.
    expect(container.querySelectorAll("button").length).toBe(0);
  });
});
