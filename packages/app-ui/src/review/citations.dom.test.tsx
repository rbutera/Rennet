// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { type CodeRef, useSpanRead } from "./citations";

const ref: CodeRef = {
  patchsetId: "ps-1",
  path: "packages/core/src/decompose.ts",
  side: "head",
  startLine: 42,
  endLine: 43,
};

function Reader({ codeRef }: { codeRef: CodeRef | null }) {
  const { data, error, pending } = useSpanRead(codeRef);
  if (error) return <span>error:{(error as Error).message}</span>;
  if (pending) return <span>loading</span>;
  if (!data) return <span>idle</span>;
  return <span>lines:{data.lines.join("|")}</span>;
}

describe("citations seam — the single span-read resolution point", () => {
  it("resolves a span from the captured patchset via patchset.readSpan", async () => {
    const bridge = new MemoryBridge({
      "patchset.readSpan": (input) => {
        expect(input.patchsetId).toBe("ps-1");
        return { lines: ["const a = 1", "const b = 2"], contextBefore: [], contextAfter: [] };
      },
    });
    const { getByText } = mount(
      <BridgeProvider bridge={bridge}>
        <Reader codeRef={ref} />
      </BridgeProvider>,
    );
    await waitFor(() => expect(getByText("lines:const a = 1|const b = 2")).toBeTruthy());
  });

  it("surfaces the unbound-dispatch throw as error data, not a thrown render", async () => {
    // No handler → the MemoryBridge rejects (mirroring production's unbound dispatch);
    // the seam surfaces that as `error`, which a caller renders as one honest line.
    const bridge = new MemoryBridge({});
    const { getByText } = mount(
      <BridgeProvider bridge={bridge}>
        <Reader codeRef={ref} />
      </BridgeProvider>,
    );
    await waitFor(() =>
      expect(
        getByText(/error:MemoryBridge: no handler for command "patchset.readSpan"/),
      ).toBeTruthy(),
    );
  });

  it("a null ref never fetches — the read stays idle", () => {
    const bridge = new MemoryBridge({
      "patchset.readSpan": () => {
        throw new Error("must not be called");
      },
    });
    const { getByText } = mount(
      <BridgeProvider bridge={bridge}>
        <Reader codeRef={null} />
      </BridgeProvider>,
    );
    expect(getByText("idle")).toBeTruthy();
  });
});
