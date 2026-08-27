import path from "node:path";
import { fileURLToPath } from "node:url";
import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Kit-not-hand-rolled (autopsy S6), proved two ways — the hex-lint.test.ts mirror
// AND the invoke-lint.test.ts real-config probe:
//   1. A standalone config with the selector copied from eslint.config.mjs shows
//      the selector itself catches a hand-rolled `aria-pressed` and passes a
//      `<ToggleGroup>` — the acceptance criterion as a fast unit.
//   2. A probe linted at a PROTECTED surface filepath through the REAL repository
//      config proves the rule is actually wired into eslint.config.mjs (a copied
//      selector stays green even if the flat-config wiring silently drops it).
const TOGGLE_SELECTOR =
  "JSXAttribute[name.name='aria-pressed'], JSXAttribute[name.name='role'][value.value='radiogroup']";

function mirrorESLint() {
  return new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      files: ["**/*.tsx"],
      languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
      rules: {
        "no-restricted-syntax": [
          "error",
          { selector: TOGGLE_SELECTOR, message: "Use ToggleGroup/Toggle from @rennet/ui." },
        ],
      },
    },
  });
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// A surface path NOT in eslint-suppressions.json — so a hand-roll here fails.
const SURFACE_PROBE = "packages/app-ui/src/components/__toggle_probe__.tsx";

async function restrictedSyntax(code: string, filePath: string) {
  const [result] = await new ESLint({ cwd: repoRoot }).lintText(code, {
    filePath,
    warnIgnored: false,
  });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-syntax");
}

describe("no-handrolled-toggle — the kit-not-hand-rolled law (S6)", () => {
  it("fails a hand-rolled aria-pressed button and names ToggleGroup (mirror)", async () => {
    const [result] = await mirrorESLint().lintText(
      "export const Seg = ({ x }: { x: boolean }) => <button aria-pressed={x}>A</button>;\n",
      { filePath: "seg.tsx" },
    );
    expect(result?.errorCount).toBeGreaterThan(0);
    expect(result?.messages[0]?.message).toContain("ToggleGroup");
  });

  it("fails hand-rolled role=radiogroup markup (mirror)", async () => {
    const [result] = await mirrorESLint().lintText(
      'export const Seg = () => <div role="radiogroup" />;\n',
      { filePath: "seg.tsx" },
    );
    expect(result?.errorCount).toBeGreaterThan(0);
  });

  it("passes a ToggleGroup usage (mirror)", async () => {
    const [result] = await mirrorESLint().lintText(
      'export const Seg = () => <ToggleGroup defaultValue={["a"]} />;\n',
      { filePath: "seg.tsx" },
    );
    expect(result?.errorCount).toBe(0);
  });

  it("bans a hand-rolled toggle on a surface file — against the REAL repo config", async () => {
    const messages = await restrictedSyntax(
      "export const Seg = ({ x }: { x: boolean }) => <button aria-pressed={x}>A</button>;\n",
      SURFACE_PROBE,
    );
    expect(messages.some((m) => /ToggleGroup/.test(m.message))).toBe(true);
  });
});
