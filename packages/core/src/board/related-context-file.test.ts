import type { DossierItem } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  RELATED_CONTEXT_FILE,
  RELATED_CONTEXT_MAX_ITEMS,
  relatedContextFile,
  relatedContextRefsFile,
} from "./related-context-file";

const FETCHED = "2026-09-12T10:00:00.000Z";

function item(overrides: Partial<DossierItem> & { id: string }): DossierItem {
  return {
    tracker: "github",
    title: `Issue ${overrides.id}`,
    state: "open",
    body: `The reporter's words for ${overrides.id}.`,
    url: `https://github.com/o/r/issues/${overrides.id.replace(/\D/g, "")}`,
    provenance: "pr-body",
    fetchedAt: FETCHED,
    ...overrides,
  };
}

/** `n` items, ids `#1`…`#n`, in dossier order. */
function items(n: number): DossierItem[] {
  return Array.from({ length: n }, (_, index) => item({ id: `#${index + 1}` }));
}

describe("relatedContextFile", () => {
  it("renders every item's id, tracker, title, state, url, provenance and body", () => {
    const file = relatedContextFile([
      item({ id: "#7", title: "Board waits for related issues", provenance: "branch-name" }),
    ]);
    expect(file?.name).toBe(RELATED_CONTEXT_FILE);
    expect(file?.body).toContain("## #7 — Board waits for related issues");
    expect(file?.body).toContain("- Tracker: github");
    expect(file?.body).toContain("- State: open");
    expect(file?.body).toContain("- URL: https://github.com/o/r/issues/7");
    expect(file?.body).toContain("- Found via: branch-name");
    expect(file?.body).toContain("The reporter's words for #7.");
    expect(file?.holds).toContain("linked to this branch");
    expect(file?.readWhen).toContain("no specification");
  });

  it("keeps dossier order rather than re-sorting", () => {
    const file = relatedContextFile([item({ id: "#9" }), item({ id: "#2" }), item({ id: "#40" })]);
    const order = [...(file?.body.matchAll(/^## (#\d+) /gm) ?? [])].map((match) => match[1]);
    expect(order).toEqual(["#9", "#2", "#40"]);
  });

  it("is undefined for no items — a prompt must not name an unwritten file", () => {
    expect(relatedContextFile([])).toBeUndefined();
  });

  it("caps at 20 items and the closing line names the dropped count", () => {
    expect(RELATED_CONTEXT_MAX_ITEMS).toBe(20);
    const file = relatedContextFile(items(21));
    expect(file?.body).not.toContain("## #21 ");
    expect(file?.body).toContain("… truncated, 1 more item not listed.");
    // The 20 under the cap are all there, so the drop is the cap and nothing else.
    for (let n = 1; n <= 20; n += 1) expect(file?.body).toContain(`## #${n} —`);
  });

  it("positive control: exactly 20 items carries all 20 and no closing line", () => {
    const file = relatedContextFile(items(20));
    for (let n = 1; n <= 20; n += 1) expect(file?.body).toContain(`## #${n} —`);
    expect(file?.body).not.toContain("truncated");
  });

  it("holds the byte bound, keeps the last item whole, and counts what it dropped", () => {
    const fat = Array.from({ length: 6 }, (_, index) =>
      item({ id: `#${index + 1}`, body: "x".repeat(1_000) }),
    );
    const maxBytes = 3_000;
    const file = relatedContextFile(fat, { maxBytes });
    const bytes = new TextEncoder().encode(file?.body ?? "").length;
    expect(bytes).toBeLessThanOrEqual(maxBytes);

    const kept = [...(file?.body.matchAll(/^## (#\d+) /gm) ?? [])].map((match) => match[1]);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(fat.length);
    expect(file?.body).toContain(`… truncated, ${fat.length - kept.length} more items not listed.`);

    // Whole, not cut mid-body: the last kept item still carries its url and its full body.
    const last = kept.at(-1) ?? "";
    const lastIndex = Number(last.slice(1));
    expect(file?.body).toContain(`- URL: https://github.com/o/r/issues/${lastIndex}`);
    expect(file?.body).toContain("x".repeat(1_000));
    // ...and the first dropped item is absent entirely, header line and url alike.
    expect(file?.body).not.toContain(`## #${lastIndex + 1} —`);
    expect(file?.body).not.toContain(`- URL: https://github.com/o/r/issues/${lastIndex + 1}`);
  });

  it("puts acceptance criteria under their own subheading, only where there are any", () => {
    const file = relatedContextFile([
      item({ id: "#1", acceptanceCriteria: "- The tab shows the overview\n- The stat says none" }),
      item({ id: "#2" }),
    ]);
    const [regionOne = "", regionTwo = ""] = (file?.body ?? "").split("## #2 —");
    expect(regionOne).toContain("### Acceptance criteria");
    expect(regionOne).toContain("- The tab shows the overview");
    expect(regionTwo).not.toContain("### Acceptance criteria");
    // Positive control on the subheading itself: drop the criteria and it goes away.
    expect(relatedContextFile([item({ id: "#1" })])?.body).not.toContain("### Acceptance criteria");
  });

  it("is deterministic: the same items render byte-identical bodies", () => {
    const first = relatedContextFile(items(5));
    const second = relatedContextFile(items(5));
    expect(first?.body).toBe(second?.body);
    // Control: a changed item changes the bytes, so the assertion above is not vacuous.
    const changed = relatedContextFile([...items(4), item({ id: "#5", state: "closed" })]);
    expect(changed?.body).not.toBe(first?.body);
  });
});

describe("relatedContextRefsFile", () => {
  it("opens on the not-finished line and lists each ref's url and provenance", () => {
    const file = relatedContextRefsFile([
      { label: "#12", url: "https://github.com/o/r/issues/12", provenance: "branch-name" },
      { label: "ABC-3", provenance: "commit-message" },
    ]);
    expect(file?.name).toBe(RELATED_CONTEXT_FILE);
    expect(file?.body.split("\n")[2]).toContain("retrieval had NOT finished");
    expect(file?.body).toContain(
      "- #12 — https://github.com/o/r/issues/12 — found via branch-name",
    );
    expect(file?.body).toContain("- ABC-3 — no URL resolved — found via commit-message");
    expect(file?.body).toContain("gh issue view <n>");
    expect(file?.body).toContain("gh pr view <n>");
    expect(file?.holds).toContain("retrieval had not finished");
  });

  it("is undefined for no refs", () => {
    expect(relatedContextRefsFile([])).toBeUndefined();
  });

  it("caps the list and names what it dropped", () => {
    const refs = Array.from({ length: 23 }, (_, index) => ({
      label: `#${index + 1}`,
      url: `https://github.com/o/r/issues/${index + 1}`,
      provenance: "pr-body",
    }));
    const file = relatedContextRefsFile(refs);
    expect(file?.body).toContain("- #20 — ");
    expect(file?.body).not.toContain("- #21 — ");
    expect(file?.body).toContain("… truncated, 3 more items not listed.");
    // Control: under the cap, no marker.
    expect(relatedContextRefsFile(refs.slice(0, 20))?.body).not.toContain("truncated");
  });
});
