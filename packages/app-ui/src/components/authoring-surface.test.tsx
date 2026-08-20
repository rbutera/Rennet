import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  addToBatch,
  authorDisposition,
  batchPayload,
  type DispositionBatch,
  draftsFromAuthored,
  editDraftBody,
  editDraftType,
  type OrphanedDisposition,
  withdrawDraft,
} from "../canvas/authoring";
import { demoCanvases } from "../canvas/fixtures";
import { coverageMosaic, type ViewEvent } from "../canvas/read-state";
import { BatchView } from "./batch-view";
import { CoverageMosaicView } from "./coverage";
import { GranularityAuthor } from "./granularity-author";
import { OrphanTray } from "./orphan-tray";

const noop = () => undefined;
const canvases = demoCanvases();

function seededBatch(body: string): DispositionBatch {
  return addToBatch(
    [],
    draftsFromAuthored(
      authorDisposition(canvases.decisions, {
        granularity: "cohort",
        cohortKey: "cohort:c2",
        type: "comment",
        body,
      }),
    ),
  );
}

describe("BatchView — renders exactly the publish/handoff payload", () => {
  it("renders every batch entry (path + body) with a withdraw control", () => {
    const html = renderToStaticMarkup(<BatchView batch={seededBatch("raw note")} />);
    expect(html).toContain("src/module-2/file-1.ts");
    expect(html).toContain("src/module-2/file-2.ts");
    expect(html).toContain("raw note");
    expect(html.toLowerCase()).toContain("withdraw");
  });

  it("shows zero residue of a withdrawn entry", () => {
    const sentinel = "SENTINEL-XyZ";
    let batch = seededBatch(sentinel);
    for (const path of ["src/module-2/file-1.ts", "src/module-2/file-2.ts"]) {
      batch = withdrawDraft(batch, path);
    }
    const html = renderToStaticMarkup(<BatchView batch={batch} />);
    expect(html).not.toContain(sentinel);
  });

  it("renders bytes equal to batchPayload (reconstructed from the view, not eyeballed)", () => {
    // Two entries made distinct in path, type AND body so order + per-entry
    // pairing are all load-bearing. Reconstruct the payload from what <BatchView>
    // actually RENDERS and assert it is byte-identical to batchPayload(batch).
    // Goes red if the component renders the raw/unsorted batch, a different body,
    // or a different order than the canonical payload.
    let batch = seededBatch("body-one");
    batch = editDraftBody(batch, "src/module-2/file-2.ts", "body-two");
    batch = editDraftType(batch, "src/module-2/file-2.ts", "request-change");
    const html = renderToStaticMarkup(<BatchView batch={batch} />);
    const entryRe =
      /<li[^>]*\bdata-path="([^"]*)"[^>]*\bdata-type="([^"]*)"[^>]*>.*?<textarea[^>]*>([^<]*)<\/textarea>/gs;
    const reconstructed = [...html.matchAll(entryRe)].map(([, path, type, body]) => ({
      path,
      type,
      body,
    }));
    expect(reconstructed).toHaveLength(2);
    expect(JSON.stringify(reconstructed)).toBe(batchPayload(batch));
  });
});

describe("OrphanTray — a dropped disposition surfaces, never vanishes", () => {
  const orphans: OrphanedDisposition[] = [
    {
      anchor: { path: "src/changed.ts", contentDigest: "old" },
      type: "request-change",
      body: "needs work",
    },
  ];

  it("renders each orphaned disposition with a did-not-carry signal", () => {
    const html = renderToStaticMarkup(<OrphanTray orphans={orphans} />);
    expect(html).toContain("src/changed.ts");
    expect(html.toLowerCase()).toContain("carry");
  });

  it("renders nothing when there are no orphans", () => {
    expect(renderToStaticMarkup(<OrphanTray orphans={[]} />)).toBe("");
  });
});

describe("CoverageMosaicView — read/skimmed/unread over the whole changeset", () => {
  const paths = ["a.ts", "b.ts", "c.ts"];
  const events: ViewEvent[] = [
    { type: "Actioned", path: "a.ts" },
    { type: "ScrolledPast", path: "b.ts" },
  ];

  it("renders the mosaic cells with their read-state and the figures", () => {
    const html = renderToStaticMarkup(
      <CoverageMosaicView mosaic={coverageMosaic(paths, events)} onGotoNextUnread={noop} />,
    );
    expect(html).toContain('data-state="read"');
    expect(html).toContain('data-state="skimmed"');
    expect(html).toContain('data-state="unread"');
    expect(html.toLowerCase()).toContain("next unread");
  });
});

describe("GranularityAuthor — the affordance at every altitude of the ladder", () => {
  it("renders all six altitudes", () => {
    const html = renderToStaticMarkup(<GranularityAuthor onAuthor={noop} />);
    for (const label of ["Line", "Hunk", "Symbol", "Element", "Cohort", "Roll-up"]) {
      expect(html).toContain(label);
    }
  });
});
