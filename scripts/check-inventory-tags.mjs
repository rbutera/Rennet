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

// ─────────────────────────────────────────────────────────────────────────────
// C20 (#558) re-ruling check. The corner-slot chrome deliberately contradicts the
// claims below: the 48px rail is gone, the wordmark moved, and the chat header's
// collapse control left. C14 audits against this file, so each contradicted claim
// must stay IN PLACE and carry its re-ruling annotation. Both failure directions
// matter — an un-annotated claim is a stale lie in the record, and a DELETED claim
// is worse, because the audit cannot tell a deliberate re-ruling from an oversight.
// ─────────────────────────────────────────────────────────────────────────────
const C20_ANNOTATION = "(re-ruled by C20 / #558 — Rai 2026-08-28)";
const C20_RERULED = [
  "The sidebar collapses between a 256px full panel and a 48px icon rail",
  "Both the expanded panel and the rail carry a collapse/expand control",
  "The collapsed rail carries Search above New Chat at the top",
  "An Update control sits at the sidebar's foot",
  "Header height is two deliberate tiers",
  "The header is a three-column grid: left slot",
  "When the chat column is collapsed, the header's left slot shows an expand-chat control",
  "The chat-pane header is 56px and carries the two-line session trail plus a collapse control",
  "Collapsing the chat reveals the same trail and an expand affordance in the main top bar",
  "The sidebar's Search row and the rail's Search button open the same menu",
];
for (const claim of C20_RERULED) {
  const matches = lines.map((line, i) => [line, i + 1]).filter(([line]) => line.includes(claim));
  if (matches.length === 0) {
    errors.push(`C20 re-ruled claim matches NO line (deleted?): "${claim}"`);
    continue;
  }
  for (const [line, n] of matches) {
    if (!line.includes(C20_ANNOTATION)) {
      errors.push(`line ${n}: C20-invalidated claim is missing "${C20_ANNOTATION}"`);
    }
  }
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
if (errors.length) {
  console.error(`FAIL: ${errors.length} inventory problem(s):`);
  for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
  if (errors.length > 20) console.error(`  … and ${errors.length - 20} more`);
  process.exit(1);
}
console.log(`OK: ${total} claim lines each tagged exactly once`);
console.log(`OK: ${C20_RERULED.length} C20-invalidated claims present and annotated`);
console.log(
  Object.entries(counts)
    .sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)))
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n"),
);
