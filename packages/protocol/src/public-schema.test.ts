import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLIC_SCHEMA_NAMES, publicSchemaText } from "./public-schema";

// The checked-in fixtures live at `packages/protocol/public-schema/<name>.json`.
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public-schema");
const fixturePath = (name: string): string => join(fixtureDir, `${name}.json`);

describe("public-schema fixtures (R19 drift guard)", () => {
  // Escape hatch: regenerate every fixture, then review the diff.
  //   UPDATE_PUBLIC_SCHEMA=1 pnpm nx test rennet-protocol
  if (process.env.UPDATE_PUBLIC_SCHEMA) {
    it("regenerates fixtures", () => {
      for (const name of PUBLIC_SCHEMA_NAMES)
        writeFileSync(fixturePath(name), publicSchemaText(name));
      expect(PUBLIC_SCHEMA_NAMES.length).toBeGreaterThan(0);
    });
    return;
  }

  it.each(PUBLIC_SCHEMA_NAMES)("%s matches its checked-in fixture", (name) => {
    let onDisk: string;
    try {
      onDisk = readFileSync(fixturePath(name), "utf8");
    } catch {
      throw new Error(
        `Missing public-schema fixture for "${name}". Regenerate with UPDATE_PUBLIC_SCHEMA=1 pnpm nx test rennet-protocol and review the diff.`,
      );
    }
    // Byte-for-byte: a silent change to the projected contract must fail loudly here.
    expect(
      onDisk,
      `public-schema/${name}.json drifted — regenerate with UPDATE_PUBLIC_SCHEMA=1 and review the diff`,
    ).toBe(publicSchemaText(name));
  });
});
