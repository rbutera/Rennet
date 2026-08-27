import { commands } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildDispatchTable, createDispatchRuntime, type DispatchDeps } from "./dispatch";

// The registry-vs-router diff-empty proof (#465, tasks 1.4). The 2,357-line `switch (name)`
// was replaced by a `Map<commandId, handler>` assembled from the per-family modules; this
// asserts the map serves EVERY command id the `protocol/commands` registry declares — and no
// extras. `createDispatchRuntime` invokes nothing on `deps` at construction, and
// `buildDispatchTable` never calls a handler, so a stub deps is enough to enumerate the keys.
//
// Positive control (shown once, never committed as a failing test): dropping a family spread
// from `buildDispatchTable` — or renaming one command id — makes `MissingCommand` non-`never`
// so the build fails at compile time, and this test's `toEqual` fails at runtime. Both proofs
// can fail.
describe("dispatch map ↔ registry (diff-empty proof, #465)", () => {
  it("serves exactly the command ids the registry declares", () => {
    const table = buildDispatchTable(createDispatchRuntime({} as DispatchDeps));
    const mapIds = Object.keys(table).sort();
    const registryIds = Object.keys(commands).sort();
    expect(mapIds).toEqual(registryIds);
  });
});
