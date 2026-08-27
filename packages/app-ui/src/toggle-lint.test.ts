import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Kit-not-hand-rolled (autopsy S6), proved against the REAL repository config
// (eslint.config.mjs) — never a copied selector, so this catches a flat-config
// mis-wire. Two things are under test:
//   1. NARROWING (finding 2): the rule fires on the GROUP shape (sibling / mapped
//      aria-pressed, or a role=radiogroup that hand-rolls aria-pressed) and lets a
//      LONE toggle through (the legit pin button, a mute). Probed at a non-quarantined
//      surface path so any leak = error.
//   2. COUNT INDEPENDENCE (finding 1): each fence now has its OWN rule id, so the
//      strangler baseline (eslint-suppressions.json) counts toggles separately from
//      invoke/hex. A NEW hand-rolled group pushes the per-rule count past baseline and
//      FAILS even in a file whose only baseline entry is an invoke — it can no longer
//      hide behind a drained invoke/hex, which the old single-id count allowed.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TOGGLE_RULE = "rennet/no-handrolled-toggle";

// A surface path NOT in eslint-suppressions.json — a hand-rolled group here fails.
const SURFACE_PROBE = "packages/app-ui/src/components/__toggle_probe__.tsx";

function repoESLint(opts: ESLint.Options = {}) {
  return new ESLint({ cwd: repoRoot, ...opts });
}

async function toggleMessages(code: string, filePath: string, opts: ESLint.Options = {}) {
  const [result] = await repoESLint(opts).lintText(code, { filePath, warnIgnored: false });
  return (result?.messages ?? []).filter((m) => m.ruleId === TOGGLE_RULE);
}

function readSource(rel: string) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

// A fresh sibling group of two aria-pressed buttons — a hand-rolled segmented control.
const APPENDED_GROUP =
  '\nexport const __ProbeSeg = ({ a, b }: { a: boolean; b: boolean }) => (\n  <div><button type="button" aria-pressed={a}>A</button><button type="button" aria-pressed={b}>B</button></div>\n);\n';

describe("no-handrolled-toggle — narrowed to the group shape (real repo config)", () => {
  it("passes a LONE aria-pressed toggle (a pin/mute button is not a segmented control)", async () => {
    const messages = await toggleMessages(
      'export const Pin = ({ on }: { on: boolean }) => <button type="button" aria-pressed={on}>Pin</button>;\n',
      SURFACE_PROBE,
    );
    expect(messages).toHaveLength(0);
  });

  it("passes a real radio-group (role=radio + aria-checked, no aria-pressed)", async () => {
    const messages = await toggleMessages(
      'export const G = ({ a, b }: { a: boolean; b: boolean }) => (\n  <div role="radiogroup"><button role="radio" aria-checked={a}>A</button><button role="radio" aria-checked={b}>B</button></div>\n);\n',
      SURFACE_PROBE,
    );
    expect(messages).toHaveLength(0);
  });

  it("fails two SIBLING aria-pressed buttons (a static hand-rolled group)", async () => {
    const messages = await toggleMessages(
      "export const Seg = ({ a, b }: { a: boolean; b: boolean }) => (\n  <div><button aria-pressed={a}>A</button><button aria-pressed={b}>B</button></div>\n);\n",
      SURFACE_PROBE,
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.message).toContain("ToggleGroup");
  });

  it("fails a MAPPED aria-pressed (the expression-form group the old lone-selector caught only by accident)", async () => {
    const messages = await toggleMessages(
      "export const Seg = ({ items }: { items: { id: string; on: boolean }[] }) => (\n  <div>{items.map((i) => <button key={i.id} aria-pressed={i.on}>{i.id}</button>)}</div>\n);\n",
      SURFACE_PROBE,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("fails a role=radiogroup that hand-rolls aria-pressed children", async () => {
    const messages = await toggleMessages(
      'export const Seg = ({ a }: { a: boolean }) => (\n  <div role="radiogroup"><button aria-pressed={a}>A</button></div>\n);\n',
      SURFACE_PROBE,
    );
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe("no-handrolled-toggle — the baseline counts toggles independently (finding 1)", () => {
  const sourceSwitcher = "packages/app-ui/src/components/source-switcher.tsx";
  // A file whose ONLY baseline entry is an invoke (no toggle) — proves independence.
  const connectionHost = "packages/app-ui/src/components/connection-host.tsx";

  it("passes a REPLACE-in-kind: swapping which toggle exists keeps the count at baseline", async () => {
    const original = readSource(sourceSwitcher);
    // Same single mapped toggle, different expression — count unchanged (1 == baseline).
    const swapped = original.replace(
      "aria-pressed={isSelected}",
      "aria-pressed={source.id === selected}",
    );
    expect(swapped).not.toBe(original);
    const messages = await toggleMessages(swapped, sourceSwitcher, { applySuppressions: true });
    expect(messages).toHaveLength(0);
  });

  it("fails an APPEND: a new hand-rolled group pushes the toggle count past baseline", async () => {
    const appended = readSource(sourceSwitcher) + APPENDED_GROUP;
    const messages = await toggleMessages(appended, sourceSwitcher, { applySuppressions: true });
    expect(messages.length).toBeGreaterThan(0);
  });

  it("fails a NEW toggle in an invoke-only file — a toggle cannot hide behind a suppressed invoke", async () => {
    const appended = readSource(connectionHost) + APPENDED_GROUP;
    const messages = await toggleMessages(appended, connectionHost, { applySuppressions: true });
    expect(messages.length).toBeGreaterThan(0);
  });

  it("defeats the exact count-masking: remove the invoke AND add a toggle, still FAILS", async () => {
    // Old single-id scheme: -1 invoke +1 toggle kept the merged count at baseline and PASSED.
    // With distinct ids the drained invoke frees nothing for the toggle, so it leaks.
    const drainedInvokePlusToggle =
      readSource(connectionHost).replace("temp.bridge.invoke(", "temp.bridge.call(") +
      APPENDED_GROUP;
    const [result] = await repoESLint({ applySuppressions: true }).lintText(
      drainedInvokePlusToggle,
      {
        filePath: connectionHost,
        warnIgnored: false,
      },
    );
    const messages = result?.messages ?? [];
    expect(messages.some((m) => m.ruleId === TOGGLE_RULE)).toBe(true);
    // The invoke is gone (0 <= baseline 1), so it does NOT leak — only the toggle does.
    expect(messages.some((m) => m.ruleId === "rennet/no-direct-invoke")).toBe(false);
  });
});
