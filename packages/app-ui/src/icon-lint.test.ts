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

/** Every `path:line: <Name` where a lucide component is rendered directly. */
function rawLucideElements(source: string, label: string): string[] {
  const found: string[] = [];
  for (const name of lucideNames(source)) {
    for (const hit of source.matchAll(new RegExp(`<${name}(?=[\\s/>])`, "g"))) {
      found.push(`${label}:${source.slice(0, hit.index).split("\n").length}: <${name}`);
    }
  }
  return found;
}

describe("every lucide icon renders through the Icon wrapper", () => {
  // The positive control, in the file it guards: the detector is handed a source that
  // DOES render a raw lucide element, and must report it. Without this the suite below
  // passes just as happily when the regex is broken and finds nothing anywhere — the
  // exact shape of a test that cannot fail.
  it("detects a raw lucide element (control)", () => {
    const offender = [
      'import { Check, type LucideIcon } from "lucide-react";',
      "export const Row = () => <Check className='size-4' />;",
    ].join("\n");
    expect(rawLucideElements(offender, "row.tsx")).toEqual(["row.tsx:2: <Check"]);
  });

  it("does not flag a lucide component passed to Icon as a value", () => {
    const clean = [
      'import { Check } from "lucide-react";',
      'import { Icon } from "../components/icon";',
      "export const Row = () => <Icon icon={Check} className='size-4' />;",
    ].join("\n");
    expect(rawLucideElements(clean, "row.tsx")).toEqual([]);
  });

  it("finds none in packages/app-ui/src", () => {
    const offenders = sources(SRC).flatMap((path) =>
      rawLucideElements(readFileSync(path, "utf8"), path.slice(SRC.length)),
    );
    expect(offenders).toEqual([]);
  });
});
