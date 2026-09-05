import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// BOTH ENTRIES FORWARD EVERY KEYED PUSH CHANNEL.
//
// The desktop app has TWO composition roots — the Electron renderer and the served
// browser tab — and each builds its own `RennetBridge` by binding supervisor methods one
// at a time. Every push channel on `RennetBridge` is OPTIONAL, so a channel bound in one
// entry and forgotten in the other typechecks perfectly and fails silently: the surface
// that reads it simply never receives a frame, in one host only, with nothing on screen
// saying why.
//
// `lens-board-tools` shipped `onLensDraft` into that shape — a board that would stream in
// the Electron window and arrive only at settle in the browser tab. This sweep is what
// the gate can see; the alternative was two more e2e specs on a display the gate has not
// got.
//
// WHAT IT CANNOT CATCH, said plainly: it reads source text for a binding, so it proves
// the property is present and forwarded, not that the supervisor's implementation of it
// works. That is `connection-supervisor.test.ts`'s job, and it has a re-attach control.
// ─────────────────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));

/** The two composition roots. Named, not globbed: a third entry is a deliberate act and
 *  adds its own row rather than being swept up silently. */
const ENTRIES = [
  { name: "electron renderer", file: path.join(here, "renderer/index.tsx") },
  { name: "browser tab", file: path.join(here, "browser/entry.tsx") },
] as const;

/**
 * Every keyed push channel a session surface subscribes through. Hard-coded rather than
 * derived from the supervisor's own shape, because deriving it would let an empty
 * derivation satisfy both sides — the counted-literal rule.
 */
const KEYED_CHANNELS = [
  "onProgress",
  "onProjectDetailProgress",
  "onAskProjection",
  "onRoundProgress",
  "onLensDraft",
] as const;

const sourceOf = (file: string): string => fs.readFileSync(file, "utf8");

describe("every desktop entry forwards every keyed push channel", () => {
  it("sweeps two real entries and five named channels", () => {
    expect(ENTRIES).toHaveLength(2);
    expect(KEYED_CHANNELS).toHaveLength(5);
    for (const { name, file } of ENTRIES) {
      expect(fs.existsSync(file), `${name} entry exists`).toBe(true);
      // A real composition root, not an empty file the sweep would pass over.
      expect(sourceOf(file)).toContain("supervisor");
    }
  });

  it("positive control: the matcher sees a binding present and a binding absent", () => {
    const bound = "    onLensDraft: supervisor.onLensDraft.bind(supervisor),";
    expect(bound.includes("onLensDraft: supervisor.onLensDraft.bind(supervisor)")).toBe(true);
    const unbound = "    onRoundProgress: supervisor.onRoundProgress.bind(supervisor),";
    expect(unbound.includes("onLensDraft: supervisor.onLensDraft.bind(supervisor)")).toBe(false);
  });

  for (const { name, file } of ENTRIES) {
    for (const channel of KEYED_CHANNELS) {
      it(`${name} forwards ${channel}`, () => {
        expect(sourceOf(file)).toContain(`${channel}: supervisor.${channel}.bind(supervisor)`);
      });
    }
  }
});
