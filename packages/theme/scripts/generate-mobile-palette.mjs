// Emit apps/mobile/src/theme/palette.generated.ts from src/palette.css.
// Run via `pnpm nx run rennet-theme:generate`.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitMobilePalette } from "./palette-data.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(
  here,
  "..",
  "..",
  "..",
  "apps",
  "mobile",
  "src",
  "theme",
  "palette.generated.ts",
);

writeFileSync(target, emitMobilePalette());
console.log(`wrote ${target}`);
