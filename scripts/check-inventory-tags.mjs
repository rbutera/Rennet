#!/usr/bin/env node
// Verification-contract check for the board rebuild (docs/developing/plans/board-rebuild-plan.md).
// Asserts every claim line in the board-prototype inventory carries exactly one
// [ws:CN] workstream tag — the plan's "every inventory line has a home" not-done test.
// Standalone: `node scripts/check-inventory-tags.mjs`. Deleted with the inventory when the build ends.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(root, "spikes/board-prototype/INVENTORY.md");
const lines = readFileSync(FILE, "utf8").split("\n");

const KNOWN = new Set(Array.from({ length: 14 }, (_, i) => `C${i + 1}`));

const errors = [];
const counts = {};
lines.forEach((line, i) => {
  if (!line.startsWith("- [ ]")) return;
  const tags = [...line.matchAll(/\[ws:(C\d+)\]/g)].map((m) => m[1]);
  if (tags.length === 0) errors.push(`line ${i + 1}: no [ws:*] tag`);
  else if (tags.length > 1) errors.push(`line ${i + 1}: ${tags.length} tags (${tags.join(", ")})`);
  const ws = tags[0];
  if (ws && !KNOWN.has(ws)) errors.push(`line ${i + 1}: unknown workstream ${ws}`);
  if (ws) counts[ws] = (counts[ws] || 0) + 1;
});

const total = Object.values(counts).reduce((a, b) => a + b, 0);
if (errors.length) {
  console.error(`FAIL: ${errors.length} inventory line(s) not tagged exactly once:`);
  for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
  if (errors.length > 20) console.error(`  … and ${errors.length - 20} more`);
  process.exit(1);
}
console.log(`OK: ${total} claim lines each tagged exactly once`);
console.log(
  Object.entries(counts)
    .sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)))
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n"),
);
