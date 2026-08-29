// @vitest-environment happy-dom
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiffFiles, SqliteReviewStore } from "@rennet/adapters";
import { AnchorReveal, BridgeProvider } from "@rennet/app-ui";
import { WsRennetBridge } from "@rennet/client";
import { ReviewService } from "@rennet/core";
import type { CodeRef, Patchset } from "@rennet/protocol";
import {
  createDispatch,
  type DispatchDeps,
  startWsListener,
  type WsListener,
} from "@rennet/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// A code citation renders its code — driven end to end, in one place.
//
// This is the ONLY package that sees `@rennet/server` (the daemon), `@rennet/client` (the
// real WS bridge) and `@rennet/app-ui` (the surface a reviewer looks at) at once, which is
// why the seam is proven here and not in any one of them. Nothing here is stubbed: a real
// listener on a real loopback socket, a real `WsRennetBridge`, the real dispatch router
// over a real `ReviewService` over a real SQLite store, holding a patchset built by real
// `git diff`. The chain under test is the one `board/kinds/code-ref.tsx` documents:
// `AnchorReveal` → `useSpanRead` → `patchset.readSpan` → `CodeBlock`.
//
// That reality is the entire point. `patchset.readSpan` threw in the shipped app for two
// workstreams, and every test that touched it answered from a `MemoryBridge` handler — a
// stub RETURNS where the daemon THREW, so the suite stayed green while every code citation
// in the product was dead. This file cannot be green in that world.
//
// POSITIVE CONTROL (run by hand, output in the PR): restore the old throwing body of
// `patchsetHandlers` and the first test goes red — the code never renders.
// ─────────────────────────────────────────────────────────────────────────────

const temporaries: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A real repository, a real staged edit, a real `git diff`. */
function realDiff(): string {
  const root = mkdtempSync(join(tmpdir(), "rennet-citation-"));
  temporaries.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  mkdirSync(join(root, "src"), { recursive: true });
  const base = [
    "export function rennet() {",
    "  const cheese = 1;",
    "  const curd = 2;",
    "  return cheese + curd;",
    "}",
  ];
  writeFileSync(join(root, "src/cheese.ts"), `${base.join("\n")}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const edited = [...base];
  edited[2] = "  const curd = 42; // the cited line";
  writeFileSync(join(root, "src/cheese.ts"), `${edited.join("\n")}\n`);
  git(root, "add", "-A");
  return git(root, "diff", "--cached", "--no-color");
}

const rawDiff = realDiff();
const PATCHSET_ID = "ps-citation-1";
const patchset: Patchset = {
  id: PATCHSET_ID,
  createdAt: "2026-08-29T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/vanished/repo",
    commonDir: "/vanished/repo/.git",
    baseRef: "main",
    baseOid: "0".repeat(40),
    headOid: "1".repeat(40),
  },
  files: parseUnifiedDiffFiles(rawDiff),
  rawDiff,
  byteLength: Buffer.byteLength(rawDiff),
  truncated: false,
};

const bridges: WsRennetBridge[] = [];
const listeners: WsListener[] = [];

/** A real client bridge on a real socket, talking to a real daemon holding the patchset. */
async function daemonBackedBridge(): Promise<WsRennetBridge> {
  const store = new SqliteReviewStore(":memory:");
  const service = new ReviewService(
    { capture: () => Promise.reject(new Error("capture is not used here")) },
    store,
  );
  await service.createReviewFromPatchset("cmd-1", patchset);
  const dispatch = createDispatch({
    service,
    allowedRoots: new Set<string>(),
  } as unknown as DispatchDeps);
  const listener = await startWsListener({
    dispatch: dispatch as unknown as Parameters<typeof startWsListener>[0]["dispatch"],
    serverVersion: "test",
  });
  listeners.push(listener);
  const bridge = new WsRennetBridge({
    url: `ws://127.0.0.1:${listener.port}`,
    initialBackoffMs: 10,
  });
  bridges.push(bridge);
  return bridge;
}

const citation: CodeRef = {
  patchsetId: PATCHSET_ID,
  path: "src/cheese.ts",
  side: "head",
  startLine: 3,
  endLine: 3,
};

afterEach(async () => {
  cleanup();
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const listener of listeners.splice(0)) await listener.close();
});
afterAll(() => {
  for (const path of temporaries) rmSync(path, { recursive: true, force: true });
});

describe("a code citation, against the real daemon", () => {
  it("reveals the cited line's actual source, numbered from the file", async () => {
    const bridge = await daemonBackedBridge();
    const { container } = render(
      <BridgeProvider bridge={bridge}>
        <AnchorReveal citations={[citation]} />
      </BridgeProvider>,
    );

    // Chips are click-to-reveal: nothing is fetched until the reviewer asks for it.
    expect(container.querySelector("[data-line]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /cheese\.ts:3/ }));

    // The cited line, at ITS OWN file line number. Both halves matter: the text proves the
    // daemon read the captured patch, and the row's `data-line` proves the block was
    // numbered from the ref rather than from the top of the returned excerpt.
    const cited = await waitFor(() => {
      const row = container.querySelector('[data-line="3"]');
      if (!row) throw new Error("the cited line never rendered");
      return row;
    });
    expect(cited.textContent).toContain("const curd = 42; // the cited line");

    // Orientation context arrives with it, and is numbered correctly too — so a reader
    // sees where in the file they are, not a floating fragment.
    expect(container.querySelector('[data-line="2"]')?.textContent).toContain("const cheese = 1;");
    expect(container.querySelector('[data-line="4"]')?.textContent).toContain(
      "return cheese + curd;",
    );

    // The cited line is the highlighted one; its neighbours are context.
    expect(cited.getAttribute("data-line-state")).not.toBe(
      container.querySelector('[data-line="2"]')?.getAttribute("data-line-state"),
    );
  });

  it("names the specific absence when the span is outside the captured diff", async () => {
    // Not a generic failure line. A patchset holds only its hunks, so line 400 of this
    // file was never captured — and that is what the reviewer is told, in the daemon's
    // own words, carried over the real wire (the listener's error frame → the client's
    // rejection → `CitationBlock`). Before this change the surface printed a fixed
    // sentence blaming the patchset, which was untrue: the command was simply unbound.
    const bridge = await daemonBackedBridge();
    render(
      <BridgeProvider bridge={bridge}>
        <AnchorReveal citations={[{ ...citation, startLine: 400, endLine: 400 }]} />
      </BridgeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /cheese\.ts:400/ }));
    const line = await screen.findByText(/outside the diff this patchset captured/);
    expect(line.textContent).toContain("src/cheese.ts line 400 (head)");
  });
});
