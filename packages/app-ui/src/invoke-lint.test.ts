import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The bridge-seam law as a positive control (C01 §2.7 / §6.3). Mirrors the selector
// from eslint.config.mjs (`NO_DIRECT_INVOKE`); if the two drift, this test — which
// lints code strings through the ESLint API — still proves the rule catches a direct
// `bridge.invoke(...)` and passes the sanctioned `useCommand(...)` hook path. This is
// the "a component importing the bridge directly fails lint" proof, shown as evidence
// rather than asserted.
const INVOKE_SELECTOR = "CallExpression[callee.property.name='invoke']";

function lint() {
  return new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      files: ["**/*.tsx"],
      languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
      rules: {
        "no-restricted-syntax": [
          "error",
          { selector: INVOKE_SELECTOR, message: "No direct bridge.invoke in app-ui surfaces." },
        ],
      },
    },
  });
}

describe("no-direct-invoke — the bridge-seam law", () => {
  it("fails a component that calls bridge.invoke directly", async () => {
    const results = await lint().lintText(
      `export async function Boot(bridge) { return bridge.invoke("app.bootstrap", {}); }\n`,
      { filePath: "boot.tsx" },
    );
    expect(results[0]?.errorCount).toBeGreaterThan(0);
    expect(results[0]?.messages[0]?.message).toContain("invoke");
  });

  it("also catches an aliased receiver (temp.bridge.invoke)", async () => {
    const results = await lint().lintText(
      `export async function Pair(temp) { return temp.bridge.invoke("pairing.exchange", {}); }\n`,
      { filePath: "pair.tsx" },
    );
    expect(results[0]?.errorCount).toBeGreaterThan(0);
  });

  it("passes a component that reads through the useCommand hook", async () => {
    const results = await lint().lintText(
      `export function Screen() { return useCommand("app.bootstrap", {}); }\n`,
      { filePath: "screen.tsx" },
    );
    expect(results[0]?.errorCount).toBe(0);
  });
});
