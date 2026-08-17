import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DESIGN = readFileSync(fileURLToPath(new URL("../DESIGN.md", import.meta.url)), "utf8");
const CSS_SOURCES = ["styles.css", "canvas.css", "tokens.css"] as const;

interface DesignRamp {
  readonly fontPx: ReadonlySet<number>;
  readonly displayClamp: string;
  readonly radiusPx: ReadonlySet<number>;
  readonly radiusGeometry: ReadonlySet<string>;
}

function frontmatter(source: string): string {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) throw new Error("packages/ui/DESIGN.md has no frontmatter");
  return match[1];
}

function section(source: string, name: string, indent: number): string {
  const prefix = " ".repeat(indent);
  const child = " ".repeat(indent + 2);
  const match = source.match(
    new RegExp(`^${prefix}${name}:\\s*\\n((?:^${child}.*(?:\\n|$))+)`, "m"),
  );
  if (!match?.[1]) throw new Error(`packages/ui/DESIGN.md has no ${name} section`);
  return match[1];
}

function quotedValues(source: string): readonly string[] {
  return [...source.matchAll(/:\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
}

function parseRamp(source: string): DesignRamp {
  const metadata = frontmatter(source);
  const typography = section(metadata, "typography", 0);
  const display = section(typography, "display", 2);
  const scale = section(typography, "scale", 2);
  const rounded = section(metadata, "rounded", 0);
  const displayClamp = display.match(/fontSize:\s*"([^"]+)"/)?.[1];
  if (!displayClamp) throw new Error("packages/ui/DESIGN.md has no display clamp");

  const fontPx = new Set(
    quotedValues(scale).map((value) => {
      const px = value.match(/^(\d+(?:\.\d+)?)px$/)?.[1];
      if (!px) throw new Error(`non-px typography scale value: ${value}`);
      return Number(px);
    }),
  );
  const radiusPx = new Set<number>();
  const radiusGeometry = new Set<string>();
  for (const value of quotedValues(rounded)) {
    const px = value.match(/^(\d+(?:\.\d+)?)px$/)?.[1];
    if (px) radiusPx.add(Number(px));
    else radiusGeometry.add(value);
  }
  return { fontPx, displayClamp, radiusPx, radiusGeometry };
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function isRadiusProperty(property: string): boolean {
  return (
    property === "border-radius" ||
    property.endsWith("-radius") ||
    (property.startsWith("--") && property.includes("radius"))
  );
}

function violations(name: string, source: string, ramp: DesignRamp): readonly string[] {
  const css = withoutComments(source);
  const found: string[] = [];
  const declarations = /(^|[;{}])\s*([-\w]+)\s*:\s*([^;{}]+);/gm;
  for (const match of css.matchAll(declarations)) {
    const property = match[2];
    const value = match[3]?.trim();
    if (!property || !value) continue;
    const line = lineAt(css, match.index + match[0].indexOf(property));

    if (property === "font-size" || property === "font") {
      if (value.replace(/\s+/g, " ") === ramp.displayClamp) continue;
      for (const size of value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
        const numeric = Number(size[1]);
        if (!ramp.fontPx.has(numeric)) {
          found.push(`${name}:${line} ${property}: ${value} (${numeric}px is off-ramp)`);
        }
      }
    }

    if (isRadiusProperty(property)) {
      for (const size of value.matchAll(/(-?\d+(?:\.\d+)?)(px|%)/g)) {
        const literal = size[0];
        const onRamp =
          size[2] === "px" ? ramp.radiusPx.has(Number(size[1])) : ramp.radiusGeometry.has(literal);
        if (!onRamp) {
          found.push(`${name}:${line} ${property}: ${value} (${literal} is off-ramp)`);
        }
      }
    }
  }
  return found;
}

describe("desktop design ramp", () => {
  it("keeps longhand, font shorthand, and radii on the documented package ramp", () => {
    const ramp = parseRamp(DESIGN);
    const found = CSS_SOURCES.flatMap((name) => {
      const source = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
      return violations(name, source, ramp);
    });
    expect(found, found.join("\n")).toEqual([]);
  });
});
