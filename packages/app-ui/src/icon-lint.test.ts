import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Rennet's line-icon identity is a ~1.6px currentColor stroke (root DESIGN.md).
// lucide-react ships every icon at 2px, so `components/icon.tsx` exists to restore
// the product weight in ONE place — and it only works if every icon goes through it.
//
// Nothing enforced that. The weight drifted twice: ~38 raw elements across the app
// (found in the wave-3 audit) and another 22 in the first-run welcome, each rendering
// a heavier glyph beside correctly-weighted neighbours. Mixed weights in one row is the
// defect; it is invisible in a screenshot diff and no test could see it.
//
// So: a lucide import is fine (the component is passed to `<Icon icon={…}>` as a value).
// Rendering one as JSX is not.
//
// Matching on the IMPORTED name alone was not enough, and the gap was not theoretical:
// two icons in `first-run-welcome.tsx` rendered at lucide's 2px for a whole wave under
// names the file never imported — `<SchemeIcon />` and `<RowIcon …/>`, both bound by
// destructuring a tuple that carried the real lucide component. The scan below therefore
// correlates local bindings back to lucide, two ways, each with an in-file control.
//
// KNOWN GAPS, named rather than chased (a scan of `packages/app-ui/src` on 2026-08-31
// found no instance of either, so the cost of covering them buys nothing today):
//
//  • a namespace import — `import * as Lucide from "lucide-react"` then `<Lucide.Check/>`.
//  • `createElement(Check, …)`, or any other render that is not JSX.
//  • a component destructured from something other than an inline arrow parameter
//    (a hook return, an object property, a function's return value).
//
// If one of those ever appears, this file is where it gets covered — the failure it would
// hide is silent and this is the only thing looking.

const SRC = fileURLToPath(new URL(".", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/** Value-imported lucide names in a source (type-only names cannot be rendered). */
function lucideNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/gs)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const spec = raw.trim();
      if (spec === "" || spec.startsWith("type ")) continue;
      // `Check as CheckGlyph` renders under the local name.
      names.push((spec.split(/\s+as\s+/).pop() ?? spec).trim());
    }
  }
  return names;
}

/** `const Glyph = Check;` — a re-binding renders under a name the import list never carries. */
function reboundNames(source: string, imported: readonly string[]): string[] {
  const names: string[] = [];
  for (const name of imported) {
    for (const match of source.matchAll(
      new RegExp(`\\b(?:const|let|var)\\s+([A-Z]\\w*)\\s*=\\s*${name}\\s*[;,\\n]`, "g"),
    )) {
      if (match[1] !== undefined) names.push(match[1]);
    }
  }
  return names;
}

/**
 * Capitalized locals bound by ARRAY DESTRUCTURING in an arrow parameter —
 * `.map(([id, label, SchemeIcon]) => …)`. This is how both escapes travelled: the lucide
 * component sits in a tuple literal and arrives at the render site under a name the file
 * never imported, so no import-name search can reach it.
 *
 * Capitalization is what separates the component slot from its `id`/`label` neighbours,
 * and it is not a guess: React only renders a JSX identifier as a component when it is
 * capitalized, so a lowercase binding CANNOT be the icon. Applied only to files that
 * value-import lucide, which is what makes a capitalized tuple slot an icon rather than
 * some other component.
 */
function destructuredNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/\(\s*\[([^\]]*)\]\s*(?:,[^)]*)?\)\s*=>/g)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const spec = raw.trim();
      if (/^[A-Z]\w*$/.test(spec)) names.push(spec);
    }
  }
  return names;
}

/** Every `path:line: <Name` where a lucide component is rendered directly. */
function rawLucideElements(source: string, label: string): string[] {
  const imported = lucideNames(source);
  if (imported.length === 0) return [];
  const found: string[] = [];
  const candidates = new Set([
    ...imported,
    ...reboundNames(source, imported),
    ...destructuredNames(source),
  ]);
  for (const name of candidates) {
    for (const hit of source.matchAll(new RegExp(`<${name}(?=[\\s/>])`, "g"))) {
      found.push(`${label}:${source.slice(0, hit.index).split("\n").length}: <${name}`);
    }
  }
  return found.sort();
}

describe("every lucide icon renders through the Icon wrapper", () => {
  // The positive controls, in the file they guard: the detector is handed sources that DO
  // render a raw lucide element, and must report each. Without these the suite below passes
  // just as happily when a regex is broken and finds nothing anywhere — the exact shape of
  // a test that cannot fail. There is one per correlation, because a control for the
  // import-name path proves nothing about the two indirection paths beside it.
  it("detects a raw lucide element (control)", () => {
    const offender = [
      'import { Check, type LucideIcon } from "lucide-react";',
      "export const Row = () => <Check className='size-4' />;",
    ].join("\n");
    expect(rawLucideElements(offender, "row.tsx")).toEqual(["row.tsx:2: <Check"]);
  });

  it("detects a lucide component rendered under a re-bound name (control)", () => {
    const offender = [
      'import { Check } from "lucide-react";',
      "const Glyph = Check;",
      "export const Row = () => <Glyph className='size-4' />;",
    ].join("\n");
    expect(rawLucideElements(offender, "row.tsx")).toEqual(["row.tsx:3: <Glyph"]);
  });

  it("detects a lucide component rendered out of a destructured tuple (control)", () => {
    // The exact shape that escaped in `first-run-welcome.tsx`, both orderings: the icon
    // last (`[id, label, SchemeIcon]`) and the icon first with a trailing arrow parameter
    // (`[RowIcon, label, value], index`).
    const offender = [
      'import { Monitor, Sun } from "lucide-react";',
      "export const Picker = () => (",
      "  <div>",
      '    {([["system", "System", Monitor]] as const).map(([id, label, SchemeIcon]) => (',
      "      <button key={id}><SchemeIcon />{label}</button>",
      "    ))}",
      '    {([[Sun, "Light"]] as const).map(([RowIcon, label], index) => (',
      "      <span key={index}><RowIcon className='size-4' />{label}</span>",
      "    ))}",
      "  </div>",
      ");",
    ].join("\n");
    expect(rawLucideElements(offender, "picker.tsx")).toEqual([
      "picker.tsx:5: <SchemeIcon",
      "picker.tsx:8: <RowIcon",
    ]);
  });

  it("does not flag a lucide component passed to Icon as a value", () => {
    const clean = [
      'import { Check, Monitor } from "lucide-react";',
      'import { Icon } from "../components/icon";',
      "export const Row = () => <Icon icon={Check} className='size-4' />;",
      'export const Picker = () => ([["system", Monitor]] as const).map(([id, SchemeIcon]) => (',
      "  <Icon key={id} icon={SchemeIcon} />",
      "));",
    ].join("\n");
    expect(rawLucideElements(clean, "row.tsx")).toEqual([]);
  });

  it("finds none in packages/app-ui/src", () => {
    const files = sources(SRC);
    // The scan itself has to have happened. An empty file list makes the assertion below
    // pass vacuously, which is exactly what a broken `SRC` or a moved package would produce.
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((path) =>
      rawLucideElements(readFileSync(path, "utf8"), path.slice(SRC.length)),
    );
    expect(offenders).toEqual([]);
  });
});
