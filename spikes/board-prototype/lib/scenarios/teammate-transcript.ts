/**
 * `teammate` transcript — a plausible session record for reviewing PR #439
 * (daemon-in-distro runtime), grounded in the real change: real file counts,
 * real paths, real content. The conversational-add exchange at the top stays
 * as the ruling exemplar for conversational acts narrating into chat.
 * Priya's authorship is the one staged element (SCENARIOS.md).
 */

import { FileText, FolderSearch, GitPullRequest, Search, TerminalSquare } from "lucide-react"
import type { TurnData } from "@/lib/conversation-data"

export const teammateTranscript: TurnData[] = [
  {
    id: "b-t0a",
    speaker: "user",
    time: "10:39",
    paragraphs: ["Add ~/dev/orbital as a project."],
  },
  {
    id: "b-t0b",
    speaker: "orchestrator",
    time: "10:39",
    preface: [
      {
        kind: "action",
        id: "b-p0a",
        label: "Detected repository",
        detail: "orbital · main",
        state: "done",
        icon: FolderSearch,
      },
      {
        kind: "action",
        id: "b-p0b",
        label: "Walked 214 files",
        detail: "mapped commit graph",
        state: "done",
        icon: FileText,
      },
      {
        kind: "action",
        id: "b-p0c",
        label: "Indexed context",
        detail: "1 repo",
        state: "done",
        icon: Search,
      },
    ],
    paragraphs: ["Added orbital — it's under This machine now."],
  },
  {
    id: "b-t1",
    speaker: "user",
    time: "10:52",
    paragraphs: ["Open Priya's PR — the daemon-in-distro runtime. It's flagged as needing me."],
  },
  {
    id: "b-t2",
    speaker: "orchestrator",
    time: "10:52",
    preface: [
      {
        kind: "action",
        id: "b-p2a",
        label: "Fetched pull request #439",
        detail: "feat(wsl): daemon-in-distro runtime · +1724 −31 · 19 files",
        state: "done",
        icon: GitPullRequest,
      },
      {
        kind: "action",
        id: "b-p2b",
        label: "Created PR worktree",
        detail: "wsl-daemon-runtime @ af5add61",
        state: "done",
        icon: TerminalSquare,
      },
      {
        kind: "action",
        id: "b-p2c",
        label: "Read the diff",
        detail: "packages/core, packages/server, apps/desktop",
        state: "done",
        icon: FileText,
      },
      {
        kind: "action",
        id: "b-p2d",
        label: "Read the spec change",
        detail: "openspec/changes/wsl-daemon-runtime",
        state: "done",
        icon: Search,
      },
    ],
    paragraphs: [
      "Boards are ready. This moves the WSL daemon into the distro itself: the server bundle is delivered into the distro's native filesystem, spawned through wsl.exe, health-checked port-first, and the desktop picks host or distro per project. Five new modules with tests, one spec change, and a docs rewrite. The spec's routing requirement is only partially wired — the selection layer exists and is tested, but the renderer still dials one host port; the change says so itself.",
    ],
  },
  {
    id: "b-t3",
    speaker: "user",
    time: "10:56",
    paragraphs: ["Why deliver a bundle into the distro at all instead of running the host build over 9P?"],
  },
  {
    id: "b-t4",
    speaker: "orchestrator",
    time: "10:56",
    preface: [
      {
        kind: "thought",
        id: "b-th4",
        state: "done",
        seconds: 4,
        text: [
          "The stated rationale is in the spec change and ADR 0003 — cite those, then the delivery module.",
        ],
      },
      {
        kind: "action",
        id: "b-p4",
        label: "Read 3 files",
        detail: "design.md, adr/0003, wsl-bundle.ts",
        state: "done",
        icon: FileText,
      },
    ],
    paragraphs: [
      "It's stated, not inferred: running Node against a 9P-mounted checkout is what the old runtime did, and it's the thing this change exists to kill — 9P file IO made every watcher and require() crawl, and junction lstats crash under it. The bundle is copied once into the distro's own ext4 (packages/core/src/wsl-bundle.ts:90), verified after copy, and the daemon runs entirely native. The trade — a delivery step and a version-skew restart path — is handled in packages/server/src/wsl-supervisor.ts:125. The Decisions board carries the full chain with the alternatives that were weighed.",
    ],
  },
]
