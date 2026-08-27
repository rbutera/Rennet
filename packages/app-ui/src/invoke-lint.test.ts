import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The bridge-seam law as a positive control (C01 §2.7 / §6.3), lint against the REAL
// repository config (eslint.config.mjs) — never a copied selector. A copied selector
// stays green even if the actual flat-config ordering, file patterns, or the
// options-REPLACE foot-gun silently drops a rule; loading the repo config is what makes
// this a genuine positive control. We lint text at PROTECTED probe filepaths so the
// config's own `files`/`ignores` decide which rules apply:
//   • packages/app-ui/src/components/__probe__.tsx → a surface: invoke BANNED, hex BANNED
//   • packages/app-ui/src/data/__probe__.ts        → the seam: invoke ALLOWED
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SURFACE_PROBE = "packages/app-ui/src/components/__probe__.tsx";
const SEAM_PROBE = "packages/app-ui/src/data/__probe__.ts";

/** ESLint loading the repository's own flat config (eslint.config.mjs at the repo root). */
function repoESLint() {
  return new ESLint({ cwd: repoRoot });
}

/** The local `rennet/*` fence messages for a lint of `code` at `filePath`. */
async function restrictedSyntax(code: string, filePath: string) {
  const [result] = await repoESLint().lintText(code, { filePath, warnIgnored: false });
  return (result?.messages ?? []).filter((m) => m.ruleId?.startsWith("rennet/"));
}

describe("no-direct-invoke — the bridge-seam law (against the real repo config)", () => {
  it("bans a direct bridge.invoke on a surface file", async () => {
    const messages = await restrictedSyntax(
      `export function Boot(bridge: { invoke: (n: string, i: object) => unknown }) {\n  return bridge.invoke("app.bootstrap", {});\n}\n`,
      SURFACE_PROBE,
    );
    expect(messages.some((m) => /invoke/i.test(m.message))).toBe(true);
  });

  it("still bans a hardcoded hex on a surface file — the options-REPLACE foot-gun stays fixed", async () => {
    // The invoke block re-lists NO_HARDCODED_HEX because flat-config REPLACES a rule's
    // options across matching blocks. If that re-list is ever dropped, hex enforcement
    // silently vanishes on surfaces — this asserts it did not.
    const messages = await restrictedSyntax(`export const brand = "#ff0000";\n`, SURFACE_PROBE);
    expect(messages.some((m) => /hex/i.test(m.message))).toBe(true);
  });

  it("allows bridge.invoke inside the data seam (src/data/)", async () => {
    const messages = await restrictedSyntax(
      `export function get(bridge: { invoke: (n: string, i: object) => unknown }) {\n  return bridge.invoke("app.bootstrap", {});\n}\n`,
      SEAM_PROBE,
    );
    expect(messages).toHaveLength(0);
  });
});
