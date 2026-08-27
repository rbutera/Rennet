#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// Regenerable projection: one GitHub checklist issue per client workstream,
// built from the [ws:CN] tags in the board-prototype inventory. Markdown stays
// canonical; issues are a throwaway tracking view (deleted when the build ends).
// Idempotent — finds an existing issue by its title marker and edits it, else creates.
//   node scripts/inventory-issues.mjs [--dry-run]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(root, "spikes/board-prototype/INVENTORY.md");
const REPO = "rbutera/rennet";
const MARKER = "[board-rebuild:client]";
const dry = process.argv.includes("--dry-run");

const NAMES = {
  C1: "client-foundations",
  C3: "shell",
  C4: "review-machinery",
  C5: "board-surface",
  C6: "diff-view",
  C7: "chat",
  C8: "exits",
  C9: "rounds",
  C10: "settings-help",
  C11: "command-menu",
  C12: "projects-flow",
  C13: "onboarding",
  C14: "conformance-sweep",
};
// C2 (ui-kit-additions) carries no inventory claims — no issue.

// Group claim lines by workstream, preserving section headings for context.
const lines = readFileSync(FILE, "utf8").split("\n");
const byWs = {};
let section = "";
for (const line of lines) {
  const mSec = line.match(/^## (.+)/);
  if (mSec) section = mSec[1].trim();
  const m = line.match(/^- \[ \] (.*) \[ws:(C\d+)\]$/);
  if (!m) continue;
  const [, claim, ws] = m;
  byWs[ws] ||= [];
  byWs[ws].push({ section, claim });
}

function body(ws, items) {
  const bySection = {};
  for (const it of items) {
    bySection[it.section] ||= [];
    bySection[it.section].push(it.claim);
  }
  const parts = [
    `${MARKER} Inventory conformance checklist for client workstream **${ws} — ${NAMES[ws]}**.`,
    "",
    "Projected from the `[ws:*]` tags in [`spikes/board-prototype/INVENTORY.md`](https://github.com/rbutera/rennet/blob/main/spikes/board-prototype/INVENTORY.md) — the markdown is canonical; this issue is a regenerable view (see the plan's verification contract, [#489](https://github.com/rbutera/rennet/issues/489)). Tick a line only when the running client does the stated thing.",
    "",
    `**${items.length} claims.**`,
    "",
  ];
  for (const [sec, claims] of Object.entries(bySection)) {
    parts.push(`### ${sec}`);
    for (const c of claims) parts.push(`- [ ] ${c}`);
    parts.push("");
  }
  return parts.join("\n");
}

function gh(args, input) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 1 << 24,
  }).trim();
}

const existing = JSON.parse(
  gh([
    "issue",
    "list",
    "--repo",
    REPO,
    "--search",
    `${MARKER} in:title`,
    "--state",
    "all",
    "--limit",
    "50",
    "--json",
    "number,title",
  ]) || "[]",
);
const findNum = (ws) => {
  const title = `${MARKER} ${ws} ${NAMES[ws]}`;
  const hit = existing.find((e) => e.title === title);
  return hit?.number;
};

for (const ws of Object.keys(NAMES)) {
  const items = byWs[ws] || [];
  if (!items.length) {
    console.log(`skip ${ws}: no inventory claims`);
    continue;
  }
  const title = `${MARKER} ${ws} ${NAMES[ws]}`;
  const b = body(ws, items);
  const num = findNum(ws);
  if (dry) {
    console.log(`${num ? `edit #${num}` : "create"} ${title} (${items.length} claims)`);
    continue;
  }
  if (num) {
    gh(["issue", "edit", String(num), "--repo", REPO, "--body-file", "-"], b);
    console.log(`edited #${num} ${title}`);
  } else {
    const url = gh(["issue", "create", "--repo", REPO, "--title", title, "--body-file", "-"], b);
    console.log(`created ${title} -> ${url}`);
  }
}
