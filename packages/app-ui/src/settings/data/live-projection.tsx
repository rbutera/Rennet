import {
  councilPickSchema,
  type DaemonHostStatus,
  type DetectedForge,
  type ProjectSource,
  type ReviewRoleCell,
  type ReviewRoleMapping,
  type SettingsProject,
} from "@rennet/protocol";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useBridge, useCommand, useMutation } from "../../data";
import type { AgentToolId } from "../assets/agent-marks";
import { type HostOS, osFromPlatform } from "../assets/os-glyphs";
import { PROJECT_ICON_NAMES, type ProjectIconName } from "../assets/project-icon";
import { DEFAULT_WORKTREE_PATTERN, DEFAULT_WORKTREE_ROOT } from "../assets/worktree";
import {
  type DaemonInfo,
  type DetectedTool,
  EMPTY_SETTINGS_PROJECTION,
  type GuidanceRule,
  type IssueTrackerSettings,
  type ReviewRole,
  type RoleAssignment,
  type SettingsHost,
  type SettingsProjection,
  SettingsProjectionProvider,
  type TrackerKind,
  type WorktreeSettings,
} from "./projections";
import type { Layered } from "./provenance";

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE settings projection (C10 §10.1, the fold wiring). This seam is the one
// place a projection read binds to a landed backend instead of resolving honest-empty.
// After the B10 + B7 + C16 + C17 folds, FOUR projection fields have a served backend:
//
//   • hosts ← `settings.get.daemonHosts` (the enumeration + each host's label) joined
//     by `source` with `daemon.status` (C17 cluster 2), which asks each host's daemon
//     for `reachable` / `version` / `lastSeenVersion` / `updateAvailable`. A host with
//     no status entry — the read in flight, rejected, or the host simply not answered
//     for — falls to `{ reachable: false }`: the card reads honestly unreachable and
//     invents no version. A remote host's platform is never reported to us, so its
//     glyph is the neutral `unknown` mark rather than a guessed penguin.
//
//   • sourceControlByHost ← `forge.hosts` (C17 amendment B), the forge CLIs present on EACH
//     host the settings surface enumerates — GitHub / `gh` only, the #484 boundary (GitLab
//     and Bitbucket are planned, not built). Like `harness.hosts` the fan-out is SERVER-side:
//     the daemon probes each host through that host's own deps (a WSL distro's `gh` over
//     `wsl.exe`), so a distro card shows ITS `gh` rather than inheriting this machine's. A host
//     that could not be asked comes back `asked: false` and is dropped here, so its card reads
//     the honest "Connect … to detect its tooling" line. A `not-installed` forge is DROPPED
//     too, so a binary renamed out of PATH makes its row disappear instead of going stale.
//     The row's enable toggle is served (amendment A): it writes `forge.setEnabled` and
//     reads the host's ruling back off `harness.hosts`, so ruling `gh` out survives a reload.
//
//   • agentsByHost ← `harness.hosts` (C17 cluster 3). The daemon runs the real discovery
//     probes for EVERY host the settings surface enumerates — itself directly, a WSL distro
//     through `wsl.exe` — and returns the coding harnesses actually present on each, with
//     that host's own versions. Per-host detection is SERVER-side because the client holds
//     exactly ONE daemon connection (the locus daemon), so it has nothing to fan out over.
//     Each host's Agents section therefore shows ITS machine's real Claude / Codex, and the
//     Review section's Dual/Single logic reacts to what is truly there.
//
//     A host the daemon cannot interrogate comes back `asked: false` and is dropped here, so
//     its card reads "Connect …" — an unknown, not an answer. A host that WAS asked keeps its
//     key even when empty, so its card reads "No coding agents detected": a real finding about
//     a real machine. The local set is never copied onto either.
//
//     The enable toggle writes through `harness.setEnabled`, which persists the decision
//     per host on the daemon-settings rung, so a ruled-out agent stays ruled out across
//     reload and ruling it out on one host leaves it running on the others.
//
//   • reconnectHost ← `daemon.reconnect` (C17 cluster 5, #533). The host card's Reconnect
//     button dispatches a real per-host re-handshake and reports its real outcome. It
//     invalidates `daemon.status`, so a card turns reachable only because the refreshed
//     status says the host answered — a failed attempt keeps the card unreachable and shows
//     the handshake's own reason.
//
//   • updateHost ← `daemon.update` (C17 cluster 6, #534). The Update Daemon button — shown only
//     where the status carried a real `updateAvailable` — dispatches the real per-host update
//     and invalidates `daemon.status` the same way, so the new version on the card is the one
//     the host answered with afterwards. A host with no update mechanism reports its reason.
//
//   • reviewRoles ← `settings.get.reviewRoles`, written by `settings.setRoleAssignment`
//     (C16, #485). HONEST-PRESENT: the council tables are static, so the read carries
//     all eight roles with `default` provenance even on a fresh install — the Review
//     section is never a blank. An edit writes ONE (role, scenario) cell and the
//     response's re-resolved mappings are adopted straight away (the resolver's own
//     answer, never a hand-recomputed one); the `settings.get` read is invalidated so
//     the reload settles on disk truth.
//
// Every OTHER field stays EMPTY on purpose — the backend does not exist even post-fold,
// so honest-empty is the truthful answer, not a stub. Each named in the cluster-10 report:
//   – projectCount / sessionCount on a host card: `daemonHosts` enumerates hosts but
//     carries no per-host counts, so the Remove confirmation names none rather than a
//     fabricated blast radius.
//
// The per-project PREFS are served now (C18 group A): glyphByProject / worktreeByProject /
// trackerByProject / guidanceByProject read `settings.get`'s resolved `prefs`, and their
// setters write `settings.setProjectValue` / `settings.setGuidance` on the repo rung — the
// same rung `resolveTrackerConfig` folds, so a per-project tracker actually reaches
// retrieval. Each write invalidates the read it changed, so the surface settles on what is
// STORED rather than on an optimistic guess; a refused write (a malformed repo config,
// Rule 75) leaves the control where the served read put it. The project NAME rides its own
// command — `project.rename`, read back off `projects.list` — so `nameEditsPersist` and
// `projectEditsPersist` are separate flags over two separate stores.
//
// This provider wraps the live Settings takeover. Tests that mount a page directly
// supply their own projection, so the seam stays fully test-drivable; a test may still
// exercise THIS provider by supplying the four bridge handlers it reads.
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_LABEL: Record<AgentToolId, string> = { claude: "Claude", codex: "Codex" };

function agentLabel(id: string): string {
  return AGENT_LABEL[id as AgentToolId] ?? id;
}

/** The forge wire id → the source-control row's mark id + label. ONE entry: GitHub /
 *  `gh` is the only forge Rennet builds (#484 keeps GitLab/Bitbucket as planning). */
const FORGE_ROW: Record<string, { readonly markId: string; readonly label: string }> = {
  github: { markId: "gh", label: "GitHub" },
};

/** One wire cell → the projection's assignment. `null` value stays null: the role does
 *  not run in that scenario and the surface renders an em dash, never a guess. */
function toAssignment(cell: ReviewRoleCell): RoleAssignment | null {
  if (cell.value === null) return null;
  return { model: cell.value.model, effort: cell.value.effort, layer: cell.layer };
}

function toReviewRole(mapping: ReviewRoleMapping): ReviewRole {
  return {
    id: mapping.id,
    label: mapping.label,
    hint: mapping.hint,
    dual: toAssignment(mapping.dual),
    claudeOnly: toAssignment(mapping.claudeOnly),
    codexOnly: toAssignment(mapping.codexOnly),
  };
}

/** The row's mark id back to the forge's WIRE id — the id the served ruling is keyed by,
 *  so a toggle writes the same name the detection and the store both use. */
const FORGE_WIRE_ID: Record<string, string> = Object.fromEntries(
  Object.entries(FORGE_ROW).map(([wireId, row]) => [row.markId, wireId]),
);

function forgeRow(forge: DetectedForge, disabled: ReadonlySet<string>): DetectedTool {
  const row = FORGE_ROW[forge.id];
  return {
    id: row?.markId ?? forge.id,
    label: row?.label ?? forge.id,
    // No detected version means no version line — never a guess (DetectionRow).
    version: forge.version ?? undefined,
    status: forge.status,
    detail: forge.detail,
    // The SERVED per-host ruling (amendment A) — a forge the viewer ruled out on this host
    // reads off across reload, and one with no ruling reads enabled by default.
    enabled: !disabled.has(forge.id),
  };
}

/** The per-project pref keys this projection writes (C18 group A) — the wire's own key
 *  vocabulary, minus the ones no control on these pages edits. */
type ProjectPrefKey =
  | "glyph"
  | "worktreeRoot"
  | "worktreePattern"
  | "trackerKind"
  | "trackerProjectKey"
  | "trackerBaseUrl"
  | "trackerTokenEnv";

/** The tracker section's field → its pref key. */
const TRACKER_PREF_KEY = {
  projectKey: "trackerProjectKey",
  baseUrl: "trackerBaseUrl",
  tokenEnv: "trackerTokenEnv",
} as const satisfies Record<string, ProjectPrefKey>;

/** A resolved value, or the client's own default when the ladder resolved none. The
 *  LAYER is the resolver's, never invented — an unset value still reads `builtin`. */
function layeredOr(resolved: { value: string; layer: Layered<string>["layer"] }, fallback: string) {
  return resolved.value === "" ? { value: fallback, layer: resolved.layer } : resolved;
}

/** A served glyph name the icon set actually has; anything else is ignored rather than
 *  rendered as a missing glyph. */
function isProjectIconName(value: string): value is ProjectIconName {
  return (PROJECT_ICON_NAMES as readonly string[]).includes(value);
}

/** A served tracker kind, or `none` — the surface never shows a kind it cannot render. */
function trackerKind(value: string): TrackerKind {
  return value === "github" || value === "jira" || value === "linear" ? value : "none";
}

/** The host's platform, or the neutral `unknown` mark when it is genuinely not knowable. */
function hostOS(source: string, isLocal: boolean, platform: string | undefined): HostOS {
  if (isLocal) return osFromPlatform(platform);
  if (source.startsWith("wsl:")) return "wsl";
  // A paired remote host reports no platform anywhere on the wire — so we show none.
  return "unknown";
}

/** One host's daemon line. A host with NO status entry (read in flight, read rejected,
 *  or a host the daemon returned nothing for) is unreachable with nothing else — the
 *  honest fallback the card already renders, never a stubbed version. */
function daemonInfo(status: DaemonHostStatus | undefined): DaemonInfo {
  // The wire shape is a union on `reachable`, so each branch can only read the fields that
  // branch actually carries — an unreachable host has no `version` to accidentally show.
  if (!status || !status.reachable) {
    return {
      reachable: false,
      ...(status?.lastSeenVersion ? { lastSeenVersion: status.lastSeenVersion } : {}),
    };
  }
  return {
    reachable: true,
    ...(status.version ? { version: status.version } : {}),
    ...(status.updateAvailable === undefined ? {} : { updateAvailable: status.updateAvailable }),
  };
}

export function LiveSettingsProjectionProvider({ children }: { readonly children: ReactNode }) {
  const bridge = useBridge();
  // Real per-host detection (C17): each entry holds exactly the harnesses found ON that
  // host. An in-flight / rejected read yields no data, so every Agents section falls back
  // to its honest "not detected" line.
  const { data } = useCommand("harness.hosts", {});
  // ONE `settings.get`, two readers: the host ENUMERATION + each host's label (the same walk
  // `daemon.status` and `harness.hosts` make, joined below with the per-host daemon probe),
  // and the council mappings (C16) the Review section renders.
  const { data: settings } = useCommand("settings.get", {});
  const { data: status } = useCommand("daemon.status", {});
  // The forge CLIs on EACH enumerated host, probed server-side through that host's own deps.
  const { data: forges } = useCommand("forge.hosts", {});
  // The toggle is a served WRITE: it persists, then invalidates the detection read so the
  // switch reflects what is actually STORED rather than an optimistic local guess.
  const { mutate: setEnabled } = useMutation("harness.setEnabled", {
    invalidates: ["harness.hosts"],
  });
  // Reconnect (C17 cluster 5, #533) is a served operation, not a local state flip: it
  // invalidates `daemon.status`, so a card only turns reachable when the REFRESHED status
  // says the host answered — the button can never paint itself green.
  const { mutate: reconnect } = useMutation("daemon.reconnect", {
    invalidates: ["daemon.status"],
  });
  // Update Daemon (C17 cluster 6, #534) — the same served-operation shape: the refreshed status
  // is what moves the card, so the button can never paint a version the host did not report.
  const { mutate: update } = useMutation("daemon.update", {
    invalidates: ["daemon.status"],
  });
  // The Source Control row's toggle (amendment A) — the same served-write shape, invalidating
  // the same per-host read the ruling is served on, so the switch shows what is STORED.
  const { mutate: setForgeEnabled } = useMutation("forge.setEnabled", {
    invalidates: ["harness.hosts"],
  });

  // The council mappings write (C16, #485). The read above is honest-present; the write
  // returns the re-resolved mappings, which are adopted immediately so the cell settles
  // without a round-trip, then invalidated so the next `settings.get` confirms it off disk.
  const { mutate: writeRole } = useMutation("settings.setRoleAssignment", {
    invalidates: ["settings.get"],
  });
  // The per-project prefs (C18 group A). Both writes invalidate the read that carries
  // the value, so the control follows the STORE, never the click: a write the daemon
  // refused (an unresolved checkout, a malformed repo config) leaves the surface showing
  // what is actually stored.
  const { mutate: writeProjectValue } = useMutation("settings.setProjectValue", {
    invalidates: ["settings.get"],
  });
  const { mutate: writeGuidance } = useMutation("settings.setGuidance", {
    invalidates: ["settings.get", "settings.guidance"],
  });
  // The project NAME write (C18): `project.rename` persists to the projects store, and the
  // read is `projects.list` itself — the renamed `project.name` IS what the Identity field
  // shows, so no second read-model is needed. An emptied name restores the org/repo
  // identity host-side (R67).
  const { mutate: renameProject } = useMutation("project.rename", {
    invalidates: ["projects.list"],
  });
  const [adopted, setAdopted] = useState<readonly ReviewRole[] | null>(null);

  // The adoption covers exactly one gap — between a write's response and the read it
  // invalidated coming back — and must not outlive it. `settings` is a cache snapshot,
  // so its identity changes only when a fetch RESOLVES; that is disk answering, and the
  // adoption is spent. Without this, `adopted ?? served` pins the surface to one write's
  // answer forever and every later change from any other writer is invisible.
  useEffect(() => {
    // Guarding on the read itself is what makes `settings` a genuine dependency rather
    // than a bare re-run trigger: only a LANDED read retires the adoption.
    if (settings !== undefined) setAdopted(null);
  }, [settings]);

  const projection = useMemo<SettingsProjection>(() => {
    const agentsByHost: Record<string, readonly DetectedTool[]> = {};
    for (const host of data?.hosts ?? []) {
      // A host that could not be asked claims NOTHING — no key at all, so its card reads
      // "Connect …". A host that WAS asked keeps its key even when the list is empty: that
      // is the real answer "nothing is installed there", and dropping it (review finding 3)
      // told an already-probed machine to connect itself.
      if (!host.asked) continue;
      agentsByHost[host.source] = host.detected.map(
        (harness): DetectedTool => ({
          id: harness.id,
          label: agentLabel(harness.id),
          // A harness the probe RETURNED is present on that host — the honest status is
          // Available. A null version is shown as no version, never a guess (DetectionRow).
          version: harness.version ?? undefined,
          status: "available",
          detail: `Detected on this machine. Disable to rule ${agentLabel(harness.id)} out of reviews here.`,
          enabled: harness.enabled,
        }),
      );
    }
    // The daemon probe, keyed by the source it answered for. A host missing from the
    // read (or the whole read missing) simply has no entry — `daemonInfo` turns that
    // into an honestly unreachable card.
    const statusBySource = new Map(status?.hosts.map((host) => [host.source, host]) ?? []);
    const sections = settings?.daemonHosts ?? [];
    const hosts: SettingsHost[] = sections.map((section) => ({
      id: section.source,
      // The local host's card keeps the product's own name for this machine; every
      // other host reads the label the daemon composed for it.
      name: section.isLocal ? "This Machine" : section.label,
      kind: section.isLocal ? "local" : "remote",
      os: hostOS(section.source, section.isLocal, bridge.platform),
      // The routing address IS the source for a non-local host (`wsl:Ubuntu`,
      // `remote:<deviceId>`); the local machine has nothing to dial.
      address: section.isLocal ? undefined : section.source,
      daemon: daemonInfo(statusBySource.get(section.source)),
    }));

    // Each host's OWN forge CLIs (amendment B). A host that could not be asked claims NOTHING —
    // no key, so the card reads its honest "Connect … to detect its tooling" line rather than
    // inheriting the machine this client is connected to. A forge whose binary is absent is
    // DROPPED, not rendered Not Installed: renaming `gh` out of PATH makes the row disappear
    // rather than report a stale hit.
    const sourceControlByHost: Record<string, readonly DetectedTool[]> = {};
    // The rows carry the viewer's forge ruling, which is served on `harness.hosts`. Until THAT
    // read lands there is no ruling to render, and defaulting to enabled would paint a
    // persisted "ruled out" decision as an enabled switch (review finding 7) — a fabricated
    // answer, briefly, which is exactly what the served ruling exists to stop. So: no rows
    // until the ruling read has arrived, and every card holds its honest empty state.
    const rulings = data?.hosts;
    if (rulings) {
      for (const host of forges?.hosts ?? []) {
        if (!host.asked) continue;
        // This host's ruling, off the entry that arrived. No entry ⇒ nothing ruled out.
        const disabled = new Set(
          rulings.find((entry) => entry.source === host.source)?.disabledForges ?? [],
        );
        // An asked host keeps its key even with no rows — "asked, nothing installed" is an
        // answer, and the section says so rather than asking to connect a connected host.
        sourceControlByHost[host.source] = host.detected
          .filter((forge) => forge.status !== "not-installed")
          .map((forge) => forgeRow(forge, disabled));
      }
    }

    // The freshest truth wins, but only until disk answers. A write's response is the
    // resolver's answer AFTER the write, so it outranks the `settings.get` read it just
    // invalidated — the cell settles at once instead of blinking back to the pre-write
    // value. `adopted` is then DROPPED the moment the invalidated read lands (the effect
    // above), so the surface goes back to rendering served bytes and a later change from
    // any other writer is not masked by a stale adoption. Nothing here recomputes a value
    // the daemon did not return.
    const served = settings?.reviewRoles?.map(toReviewRole);

    // The per-project prefs (C18 group A), keyed by project id off the served rows.
    // ponytail: a project's FIRST repo row carries its prefs — the Projects pages are
    // scoped to a project, not a repo, so a workspace's second repo is not separately
    // editable here; per-repo pref editing needs a repo selector on those pages first.
    const rowByProject = new Map<string, SettingsProject>();
    for (const row of settings?.projects ?? []) {
      if (!rowByProject.has(row.projectId)) rowByProject.set(row.projectId, row);
    }
    const glyphByProject: Record<string, ProjectIconName> = {};
    const worktreeByProject: Record<string, WorktreeSettings> = {};
    const trackerByProject: Record<string, IssueTrackerSettings> = {};
    const guidanceByProject: Record<string, readonly GuidanceRule[]> = {};
    for (const [projectId, row] of rowByProject) {
      const prefs = row.prefs;
      // A daemon that does not serve prefs claims nothing here — the pages keep their
      // honest empty state rather than showing a value nobody resolved.
      if (!prefs) continue;
      if (isProjectIconName(prefs.glyph.value)) glyphByProject[projectId] = prefs.glyph.value;
      worktreeByProject[projectId] = {
        // An empty resolved value IS "nobody has set this", so the client's own default
        // shows — carrying the layer the resolver reported, not a fabricated one.
        root: layeredOr(prefs.worktreeRoot, DEFAULT_WORKTREE_ROOT),
        pattern: layeredOr(prefs.worktreePattern, DEFAULT_WORKTREE_PATTERN),
      };
      const kind = trackerKind(prefs.tracker.kind.value);
      const rest = kind === "jira" || kind === "linear";
      trackerByProject[projectId] = {
        kind: { value: kind, layer: prefs.tracker.kind.layer },
        // GitHub rides the host's `gh` and none needs nothing — those kinds expose no
        // endpoint fields at all, so the row is null rather than an empty input.
        projectKey: rest ? prefs.tracker.projectKey : null,
        baseUrl: rest ? prefs.tracker.baseUrl : null,
        tokenEnv: rest ? prefs.tracker.tokenEnv : null,
      };
      guidanceByProject[projectId] = prefs.guidance.map((rule) => ({
        ...(rule.id ? { id: rule.id } : {}),
        rule: rule.rule,
        severity: rule.severity,
      }));
    }

    // One pref write, addressed by the project's own repo row. A project with no served
    // row is not written to — there is nothing to address, and inventing a path would
    // write into some other repo.
    const writePref = (projectId: string, key: ProjectPrefKey, value: string | null): void => {
      // `prefsBackedByProject` is derived from THIS map, so a project with no row here
      // renders its editors disabled — there is no enabled control this guard can
      // silently swallow a write from. It never invents a path into another repo.
      const repoPath = rowByProject.get(projectId)?.repoPath;
      if (!repoPath) return;
      // A refused write (unresolved checkout, malformed repo config) leaves the control
      // where the served read put it — the invalidated read is the honest answer.
      void writeProjectValue({ projectId, repoPath, key, value }).catch(() => undefined);
    };

    return {
      ...EMPTY_SETTINGS_PROJECTION,
      // Both stores are served now: the NAME through `project.rename` (the projects
      // store), and the glyph / worktree / tracker / guidance editors through the repo
      // rung (C18 group A). Two flags because they are two stores — a daemon that serves
      // one and not the other still tells the truth about which controls persist.
      nameEditsPersist: true,
      // Derived per PROJECT from the row this projection can actually address, never
      // asserted for the surface as a whole. Two failures that fixes: a daemon still
      // running an older version returns rows with no `prefs` (those editors must stay
      // disabled), and a project whose row has not arrived has no `repoPath` to write to
      // — the SAME map decides the capability and the write address, so an enabled
      // control can never sit over a write with nowhere to go.
      prefsBackedByProject: Object.fromEntries(
        [...rowByProject].map(([projectId, row]) => [projectId, row.prefs !== undefined]),
      ),
      // The fallback for a project with no row at all: not backed, because nothing here
      // can address it. It is never an assertion about the daemon's capability.
      projectEditsPersist: false,
      setProjectName: (projectId, name) => {
        // A refused write leaves the field where it was — the invalidated `projects.list`
        // is the honest answer, never a fabricated rename.
        void renameProject({ projectId, name }).catch(() => undefined);
      },
      hosts,
      sourceControlByHost,
      agentsByHost,
      glyphByProject,
      worktreeByProject,
      trackerByProject,
      guidanceByProject,
      setProjectGlyph: (projectId, icon) => writePref(projectId, "glyph", icon),
      setWorktreeRoot: (projectId, root) => writePref(projectId, "worktreeRoot", root),
      setWorktreePattern: (projectId, pattern) => writePref(projectId, "worktreePattern", pattern),
      setTracker: (projectId, tracker) => {
        // The surface hands back the whole section; only the CHANGED keys are written,
        // so switching the kind does not rewrite three endpoint fields that did not move.
        const current = trackerByProject[projectId];
        if (tracker.kind.value !== current?.kind.value) {
          writePref(projectId, "trackerKind", tracker.kind.value);
        }
        for (const field of ["projectKey", "baseUrl", "tokenEnv"] as const) {
          const next = tracker[field]?.value ?? null;
          if (next === (current?.[field]?.value ?? null)) continue;
          writePref(projectId, TRACKER_PREF_KEY[field], next);
        }
      },
      setGuidance: (projectId, rules) => {
        const repoPath = rowByProject.get(projectId)?.repoPath;
        if (!repoPath) return;
        void writeGuidance({
          projectId,
          repoPath,
          rules: rules.map((rule) => ({
            ...(rule.id ? { id: rule.id } : {}),
            rule: rule.rule,
            severity: rule.severity,
          })),
        }).catch(() => undefined);
      },
      reconnectHost: async (hostId) => {
        try {
          const outcome = await reconnect({ source: hostId as ProjectSource });
          return {
            reachable: outcome.status.reachable,
            ...(outcome.error ? { error: outcome.error } : {}),
          };
        } catch (reason) {
          // A rejected dispatch IS a failed reconnect — reported as one, with whatever the
          // failure said, rather than swallowed into a card that keeps looking hopeful.
          return { reachable: false, error: reason instanceof Error ? reason.message : undefined };
        }
      },
      updateHost: async (hostId) => {
        try {
          const outcome = await update({ source: hostId as ProjectSource });
          return {
            reachable: outcome.status.reachable,
            ...(outcome.error ? { error: outcome.error } : {}),
          };
        } catch (reason) {
          // A rejected dispatch IS a failed update — reported as one, never swallowed into a
          // card that claims a version the host was never asked for.
          return { reachable: false, error: reason instanceof Error ? reason.message : undefined };
        }
      },
      reviewRoles: adopted ?? served ?? [],
      setRoleAssignment: (roleId, scenario, assignment) => {
        // Model + effort only — `layer` is provenance the resolver decides, not input
        // (#89: the harness follows the model, and nothing here pins one). The
        // projection's model is a plain string, so parse it against the council set at
        // this boundary rather than casting a value the command would reject anyway.
        const parsed =
          assignment === null
            ? null
            : councilPickSchema.safeParse({ model: assignment.model, effort: assignment.effort });
        if (parsed !== null && !parsed.success) return;
        void writeRole({ roleId, scenario, assignment: parsed === null ? null : parsed.data })
          .then((output) => setAdopted(output.reviewRoles.map(toReviewRole)))
          // A refused write (a malformed config, Rule 75) leaves the cell where it was;
          // the invalidated read is the honest answer, never a fabricated success.
          .catch(() => undefined);
      },
      setToolEnabled: (hostId, toolId, enabled) => {
        // ONE signature, two served stores — the row's own host decides which. Fire-and-
        // refetch in both cases: the mutation invalidates `harness.hosts`, so the row re-reads
        // the PERSISTED decision. A rejected write leaves the switch where it was — it never
        // shows a tool as ruled out when the store refused to remember it.
        // Every host id in this projection came from a served `source`, so the cast narrows
        // back to the shape the command's own schema re-validates on arrival.
        const source = hostId as ProjectSource;
        if (agentsByHost[hostId]?.some((tool) => tool.id === toolId)) {
          void setEnabled({ source, harnessId: toolId, enabled }).catch(() => undefined);
          return;
        }
        // A Source Control row (amendment A): written under the forge's WIRE id, which is
        // what the served ruling and the detection are both keyed by. Scoped to the row's own
        // host — every card's rows are now real (amendment B), so every card's toggle writes.
        const forgeId = FORGE_WIRE_ID[toolId];
        if (forgeId && sourceControlByHost[hostId]?.some((tool) => tool.id === toolId)) {
          void setForgeEnabled({ source, forgeId, enabled }).catch(() => undefined);
        }
      },
    };
  }, [
    data,
    settings,
    status,
    forges,
    bridge.platform,
    setEnabled,
    setForgeEnabled,
    reconnect,
    update,
    adopted,
    writeRole,
    writeProjectValue,
    writeGuidance,
    renameProject,
  ]);

  return <SettingsProjectionProvider value={projection}>{children}</SettingsProjectionProvider>;
}
