// @vitest-environment happy-dom
//
// The verify-ui strip (issue #183): mounts the real `FlaggedLens` over reviews
// carrying a `uiVerification` status and drives the surface — the strip renders the
// honest ran/unavailable copy, thumbnails load on demand from the injected loader, a
// not-found screenshot degrades to a plain note, a review WITHOUT the field renders
// byte-for-byte as before (additive proof), and an unavailable status beside
// unresolved findings never gates the surface (Rule Zero).
import type { FlaggedReview } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { buildFlaggedIndex } from "../canvas/flagged";
import { mount, waitFor } from "../test/dom";
import { FlaggedLens } from "./flagged";

const BASE: Extract<FlaggedReview, { status: "ok" }> = {
  status: "ok",
  findings: [
    {
      findingId: "f1",
      anchor: "rennet:hunk/h1",
      summary: "a normal finding",
      severity: "high",
      agreement: { kind: "concur", agree: 1, total: 1 },
    },
  ],
};

describe("FlaggedLens — verify-ui strip (#183)", () => {
  it("renders nothing extra for a review without the field (additive proof)", () => {
    const { container } = mount(
      <FlaggedLens index={buildFlaggedIndex(BASE)} onJumpToAnchor={vi.fn()} />,
    );
    expect(container.querySelector(".ui-verification")).toBeNull();
  });

  it("renders nothing for a not-ui status", () => {
    const review: FlaggedReview = {
      ...BASE,
      uiVerification: { status: "not-ui", classifierVersion: 1 },
    };
    const { container } = mount(
      <FlaggedLens index={buildFlaggedIndex(review)} onJumpToAnchor={vi.fn()} />,
    );
    expect(container.querySelector(".ui-verification")).toBeNull();
  });

  it("shows the honest could-not-check line for an unavailable status (never an all-clear)", () => {
    const review: FlaggedReview = {
      ...BASE,
      uiVerification: {
        status: "unavailable",
        classifierVersion: 1,
        reason: "no browser tooling in the project",
      },
    };
    const { container } = mount(
      <FlaggedLens index={buildFlaggedIndex(review)} onJumpToAnchor={vi.fn()} />,
    );
    const strip = container.querySelector(".ui-verification-unavailable");
    expect(strip?.textContent).toContain("Couldn't check");
    expect(strip?.textContent).toContain("no browser tooling in the project");
  });

  it("qualifies an empty review while verify-ui is pending", () => {
    const review: FlaggedReview = {
      status: "ok",
      findings: [],
      uiVerification: { status: "pending", classifierVersion: 1 },
    };
    const { container } = mount(
      <FlaggedLens index={buildFlaggedIndex(review)} onJumpToAnchor={vi.fn()} />,
    );
    expect(container.textContent).toContain("UI check still running");
    expect(container.textContent).toContain("not a full all-clear");
    expect(container.textContent).not.toContain("ran clean");
  });

  it("qualifies an empty review when verify-ui is unavailable", () => {
    const review: FlaggedReview = {
      status: "ok",
      findings: [],
      uiVerification: {
        status: "unavailable",
        classifierVersion: 1,
        reason: "verifier unavailable",
      },
    };
    const { container } = mount(
      <FlaggedLens index={buildFlaggedIndex(review)} onJumpToAnchor={vi.fn()} />,
    );
    expect(container.textContent).toContain("couldn't check the UI");
    expect(container.textContent).toContain("not a full all-clear");
    expect(container.textContent).not.toContain("ran clean");
  });

  it("loads and renders screenshot thumbnails from the injected loader", async () => {
    const review: FlaggedReview = {
      ...BASE,
      uiVerification: {
        status: "ran",
        classifierVersion: 1,
        mounted: true,
        observationCount: 1,
        screenshots: [{ path: "login.png", label: "login form" }],
      },
    };
    const loadUiEvidence = vi.fn(async (path: string) => `data:image/png;base64,${path}`);
    const { container } = mount(
      <FlaggedLens
        index={buildFlaggedIndex(review)}
        onJumpToAnchor={vi.fn()}
        loadUiEvidence={loadUiEvidence}
      />,
    );
    await waitFor(() => {
      const img = container.querySelector(".ui-evidence-shot img");
      expect(img?.getAttribute("src")).toBe("data:image/png;base64,login.png");
    });
    expect(loadUiEvidence).toHaveBeenCalledWith("login.png");
    expect(container.querySelector(".ui-verification-ran")?.textContent).toContain("mounted");
  });

  it("degrades to a missing-evidence note when a screenshot no longer resolves", async () => {
    const review: FlaggedReview = {
      ...BASE,
      uiVerification: {
        status: "ran",
        classifierVersion: 1,
        mounted: false,
        observationCount: 0,
        screenshots: [{ path: "gone.png", label: "removed shot" }],
      },
    };
    const loadUiEvidence = vi.fn(async () => null);
    const { container } = mount(
      <FlaggedLens
        index={buildFlaggedIndex(review)}
        onJumpToAnchor={vi.fn()}
        loadUiEvidence={loadUiEvidence}
      />,
    );
    await waitFor(() => {
      const note = container.querySelector(".ui-evidence-missing");
      expect(note?.textContent).toContain("screenshot unavailable");
    });
    // A static run labels itself honestly — never claims a mount it did not do.
    expect(container.querySelector(".ui-verification-ran")?.textContent).toContain("static review");
  });

  it("never gates: an unavailable status beside unresolved findings still renders the flags (Rule Zero)", () => {
    const review: FlaggedReview = {
      ...BASE,
      uiVerification: {
        status: "unavailable",
        classifierVersion: 1,
        reason: "could not mount",
      },
    };
    const { container } = mount(
      <FlaggedLens index={buildFlaggedIndex(review)} onJumpToAnchor={vi.fn()} />,
    );
    // The finding row is present and dispositionable exactly as without the field —
    // the strip adds no blocker, no confirmation, no disabled state.
    expect(container.querySelectorAll(".flag")).toHaveLength(1);
    expect(container.querySelector(".ui-verification-unavailable")).not.toBeNull();
  });
});
