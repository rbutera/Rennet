// @vitest-environment happy-dom
//
// The DISPOSITION CLUSTER (issue #109). Mounted-DOM proof that the four verbs are
// real controls anchored to a unit, that each carries its DEFAULT ink/blue lane
// (the material law is visible before a click), and that disposing fires the host
// callback with the right verb — the red-provable proof the cluster is WIRED, not
// just rendered.
import type { DispositionType } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { fireEvent, mount } from "../test/dom";
import { DispositionCluster } from "./disposition-cluster";

function mountCluster(
  anchor: Parameters<typeof DispositionCluster>[0]["anchor"],
  extra?: { compact?: boolean; labelled?: boolean },
) {
  const disposed: DispositionType[] = [];
  const result = mount(
    <DispositionCluster
      anchor={anchor}
      compact={extra?.compact}
      labelled={extra?.labelled}
      onDispose={(type) => disposed.push(type)}
    />,
  );
  return { ...result, disposed };
}

function verb(container: HTMLElement, type: DispositionType): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `.disposition-cluster-btn[data-type="${type}"]`,
  );
  if (!button) throw new Error(`no ${type} verb in the cluster`);
  return button;
}

describe("the four verbs, on a line anchor", () => {
  it("renders exactly the four verbs, as a labelled toolbar for the anchor", () => {
    const { container } = mountCluster({ kind: "line", label: "src/rate/bucket.ts:14" });
    const cluster = container.querySelector(".disposition-cluster");
    expect(cluster?.getAttribute("role")).toBe("toolbar");
    expect(cluster?.getAttribute("aria-label")).toBe("Dispose on line src/rate/bucket.ts:14");
    expect(container.querySelectorAll(".disposition-cluster-btn")).toHaveLength(4);
    for (const type of ["approve", "request-change", "comment", "question"] as const) {
      expect(verb(container, type)).not.toBeNull();
    }
  });

  it("carries the anchor kind on the cluster (verbs times anchors)", () => {
    const { container } = mountCluster({ kind: "chunk", label: "src/rate/bucket.ts" });
    expect(container.querySelector(".disposition-cluster")?.getAttribute("data-anchor-kind")).toBe(
      "chunk",
    );
  });
});

describe("the material law is visible on the control (ink vs blue)", () => {
  it("request-change renders in ink; approve/comment/question render blue", () => {
    const { container } = mountCluster({ kind: "line", label: "a:1" });
    // The load-bearing published verb is ink (travels to the PR).
    expect(verb(container, "request-change").getAttribute("data-lane")).toBe("ink");
    // The personal + orchestrator-bound verbs are blue (stay local by default).
    expect(verb(container, "approve").getAttribute("data-lane")).toBe("blue");
    expect(verb(container, "comment").getAttribute("data-lane")).toBe("blue");
    expect(verb(container, "question").getAttribute("data-lane")).toBe("blue");
  });
});

describe("disposing fires the host with the right verb", () => {
  it("clicking each verb disposes exactly that type on the anchor", () => {
    const { container, disposed } = mountCluster({ kind: "chunk", label: "src/x.ts" });
    fireEvent.click(verb(container, "approve"));
    fireEvent.click(verb(container, "request-change"));
    fireEvent.click(verb(container, "comment"));
    fireEvent.click(verb(container, "question"));
    expect(disposed).toEqual(["approve", "request-change", "comment", "question"]);
  });
});

describe("icon-only line rows (labelled=false)", () => {
  it("drops the word labels but keeps an accessible name per verb", () => {
    const { container } = mountCluster({ kind: "line", label: "a:7" }, { labelled: false });
    expect(container.querySelector(".disposition-cluster-label")).toBeNull();
    // The button still names itself for AT even with no visible label.
    expect(verb(container, "approve").getAttribute("aria-label")).toBe("Approve on line a:7");
  });
});
