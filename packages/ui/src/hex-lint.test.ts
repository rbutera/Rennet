import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The hex-forbidding selector, mirrored from eslint.config.mjs. If the two drift,
// this test (which lints code strings through the ESLint API) still proves the
// rule catches a hardcoded hex and passes `var(--token)` — the acceptance
// criterion "a fixture component with a hardcoded hex fails lint". Second copy of
// the app-ui test, pointed at the kit; the two packages' allowlists may diverge.
const HEX_SELECTOR = "Literal[value=/#[0-9a-fA-F]{3,8}/]";

function lint() {
  return new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      files: ["**/*.tsx"],
      languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
      rules: {
        "no-restricted-syntax": [
          "error",
          { selector: HEX_SELECTOR, message: "No hardcoded hex colours in packages/ui." },
        ],
      },
    },
  });
}

// Built from parts so the literal never appears in this file's own source (the
// repo hex rule exempts test files, but this keeps the corpus clean regardless).
const HEX = `#${"ff00aa"}`;

describe("no-hardcoded-hex — the glass-token discipline (kit)", () => {
  it("fails a component that hardcodes a hex colour", async () => {
    const results = await lint().lintText(
      `export const Swatch = () => <div style={{ color: "${HEX}" }} />;\n`,
      { filePath: "swatch.tsx" },
    );
    expect(results[0]?.errorCount).toBeGreaterThan(0);
    expect(results[0]?.messages[0]?.message).toContain("hex");
  });

  it("passes a component that uses a glass token", async () => {
    const results = await lint().lintText(
      'export const Swatch = () => <div style={{ color: "var(--code-bg)" }} />;\n',
      { filePath: "swatch.tsx" },
    );
    expect(results[0]?.errorCount).toBe(0);
  });
});
