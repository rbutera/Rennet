// @vitest-environment happy-dom
//
// Handoff-bundle composition, the renderer surface (issue #72, M24). Mounted-DOM
// proofs that the collation draft canvas offers composition in own-branch mode and
// renders the result honestly, and that the paper previews the EXACT composed prompt
// the run executes (string identity with the bundle, not a re-derivation).
import type { ComposedHandoffBundle } from "@rennet/types";
import { describe, expect, it } from "vitest";
import type { CollationDraft } from "../canvas/collation";
import { destinationVariant } from "../canvas/destination";
import { fireEvent, mount } from "../test/dom";
import { CollationDraftCanvas } from "./collation-draft-canvas";
import { PublishSheet } from "./publish-sheet";

const ownBranch = destinationVariant("own-branch");
const otherPr = destinationVariant("other-pr");

function draftOf(...paths: string[]): CollationDraft {
  return paths.map((path) => ({ id: path, path, type: "request-change", raw: `fix ${path}` }));
}

const COMPOSED: ComposedHandoffBundle = {
  reviewId: "r1",
  patchsetId: "ps-1",
  tasks: [
    {
      title: "Harden token handling in auth.ts",
      sourceDispositions: ["d0", "d1"],
      asks: [
        {
          id: "d0",
          path: "src/auth.ts",
          type: "request-change",
          instruction: "validate the token before use",
          context: "",
          span: { startLine: 10, endLine: 12 },
          side: "additions",
        },
        {
          id: "d1",
          path: "src/auth.ts",
          type: "comment",
          instruction: "also handle the expired-token case",
          context: "",
        },
      ],
    },
    {
      title: "Fix the missing-user status code",
      sourceDispositions: ["d2"],
      asks: [
        {
          id: "d2",
          path: "src/user.ts",
          type: "request-change",
          instruction: "return 404 not 500 when the user is missing",
          context: "",
        },
      ],
    },
  ],
  prompt:
    "# Review handoff\n\n### 1. src/auth.ts\n- validate the token before use\n- also handle the expired-token case\n\n### 2. src/user.ts\n- return 404 not 500 when the user is missing",
  digest: "digest-abc",
  composed: true,
  traceMap: { d0: 0, d1: 0, d2: 1 },
};

const FLOOR: ComposedHandoffBundle = {
  ...COMPOSED,
  composed: false,
  tasks: [
    {
      title: "",
      sourceDispositions: ["d0"],
      asks: [
        {
          id: "d0",
          path: "src/auth.ts",
          type: "comment",
          instruction: "a plain note",
          context: "",
        },
      ],
    },
  ],
  prompt: "# Review handoff\n\n### 1. src/auth.ts\n- a plain note",
  traceMap: { d0: 0 },
};

describe("collation draft canvas — composition (own-branch)", () => {
  it("offers 'Compose the handoff' and the button is wired to the host", () => {
    const calls: number[] = [];
    const { container } = mount(
      <CollationDraftCanvas
        draft={draftOf("src/auth.ts")}
        variant={ownBranch}
        onChange={() => undefined}
        onComposeHandoff={() => calls.push(1)}
      />,
    );
    const section = container.querySelector<HTMLElement>('[data-testid="handoff-composition"]');
    expect(section).not.toBeNull();
    const button = container.querySelector<HTMLButtonElement>(".collation-handoff-btn");
    expect(button?.textContent).toContain("Compose the handoff");
    // Wired, not decorative: clicking fires the host callback (an unwired button fails).
    if (button) fireEvent.click(button);
    expect(calls).toHaveLength(1);
  });

  it("does NOT render the composition affordance in other-pr mode", () => {
    const { container } = mount(
      <CollationDraftCanvas
        draft={draftOf("src/auth.ts")}
        variant={otherPr}
        onChange={() => undefined}
        onComposeHandoff={() => undefined}
      />,
    );
    expect(container.querySelector('[data-testid="handoff-composition"]')).toBeNull();
  });

  it("renders a model composition as grouped, ordered tasks with verbatim member asks", () => {
    const { container } = mount(
      <CollationDraftCanvas
        draft={draftOf("src/auth.ts", "src/user.ts")}
        variant={ownBranch}
        onChange={() => undefined}
        onComposeHandoff={() => undefined}
        handoffComposition={COMPOSED}
      />,
    );
    const result = container.querySelector<HTMLElement>('[data-testid="handoff-result"]');
    expect(result?.getAttribute("data-composed")).toBe("true");
    const tasks = container.querySelectorAll('[data-testid="handoff-task"]');
    expect(tasks).toHaveLength(2);
    // Preview titles are shown to the human.
    expect(container.textContent).toContain("Harden token handling in auth.ts");
    // Member ask bodies are present verbatim.
    expect(container.textContent).toContain("validate the token before use");
    expect(container.textContent).toContain("also handle the expired-token case");
    expect(container.textContent).toContain("return 404 not 500 when the user is missing");
    // Anchor label for a spanned ask.
    expect(container.textContent).toContain("lines 10–12, additions");
  });

  it("marks the mechanical floor honestly as NOT model-composed (distinct from a composition)", () => {
    const { container } = mount(
      <CollationDraftCanvas
        draft={draftOf("src/auth.ts")}
        variant={ownBranch}
        onChange={() => undefined}
        onComposeHandoff={() => undefined}
        handoffComposition={FLOOR}
        composeState={{
          status: "composed",
          resolution: {
            status: "resolved",
            harness: "codex",
            model: "gpt-5.5-codex",
            effort: "medium",
            summary: "M24 · council-table",
            failureReason: "the compose turn returned no groups array",
          },
        }}
      />,
    );
    const result = container.querySelector<HTMLElement>('[data-testid="handoff-result"]');
    expect(result?.getAttribute("data-composed")).toBe("false");
    expect(container.querySelector('[data-testid="handoff-floor-note"]')).not.toBeNull();
    expect(container.textContent).toContain("Not model-composed");
    expect(container.textContent).toContain("the compose turn returned no groups array");
    expect(container.textContent).not.toContain("no compose seat was available");
  });
});

describe("publish sheet — the handoff preview IS the executed prompt (own-branch)", () => {
  it("previews the composed prompt string verbatim (string identity with the bundle)", () => {
    const { container } = mount(
      <PublishSheet variant={ownBranch} payload="" handoffComposition={COMPOSED} />,
    );
    const prompt = container.querySelector<HTMLElement>('[data-testid="handoff-prompt"]');
    // The exact bytes the run hands the harness — not a re-derivation.
    expect(prompt?.textContent).toBe(COMPOSED.prompt);
    const order = container.querySelector<HTMLElement>('[data-testid="handoff-work-order"]');
    expect(order?.getAttribute("data-composed")).toBe("true");
  });

  it("previews the floor as the pass-through, marked not model-composed", () => {
    const { container } = mount(
      <PublishSheet variant={ownBranch} payload="" handoffComposition={FLOOR} />,
    );
    const order = container.querySelector<HTMLElement>('[data-testid="handoff-work-order"]');
    expect(order?.getAttribute("data-composed")).toBe("false");
    expect(container.querySelector('[data-testid="handoff-floor"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="handoff-prompt"]')?.textContent).toBe(
      FLOOR.prompt,
    );
  });

  it("does NOT render the composed work order in other-pr mode", () => {
    const { container } = mount(
      <PublishSheet variant={otherPr} payload="" handoffComposition={COMPOSED} />,
    );
    expect(container.querySelector('[data-testid="handoff-work-order"]')).toBeNull();
  });
});
