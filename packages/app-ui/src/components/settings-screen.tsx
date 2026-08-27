import type {
  AppearanceScheme,
  Locus,
  ProjectVisibility,
  RennetBridge,
  ResolvedProvenance,
  SettingsGuidance,
  SettingsProject,
  SettingsRepoValueKey,
  SettingsView,
} from "@rennet/protocol";
import { Button, Input } from "@rennet/ui";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import {
  COMMAND_CATALOGUE,
  type CommandDef,
  chordFromEvent,
  effectiveKeybinding,
  findConflicts,
  formatKeybinding,
  type KeybindingOverrides,
  normalizeChord,
} from "../command/commands";
import { messageFrom } from "../lib/message-from";
import { RennetBrandMark } from "./brand-mark";
import { GitHubAccountRows } from "./github-connect";
import { Icon } from "./icon";

// Shared Tailwind recipes for this Operate surface: sans throughout (the screen
// title is the one display voice). The segmented controls now ride kit `<Button>`:
// the selected segment is `variant="default"` (the gold fill = accent-fill/accent-ink),
// an inactive/plain segment is `variant="outline"`. The kept `.on` marker still
// tracks the active segment for the test hooks and the `${on ? " on" : ""}` conditionals.
const ROW = "flex flex-wrap items-center gap-4 border-b border-line py-3 [&:last-of-type]:border-0";
const ROW_LABEL = "flex flex-col gap-1";
const ROW_VALUE = "ml-auto flex flex-wrap items-center gap-2";
const KEY = "text-base font-semibold text-ink";
const DESC = "text-sm text-ink-soft";
const NOTE = "mt-3 text-sm text-ink-faint";
// Malformed / error banners share the warm gold surface (accent === decision).
const BANNER =
  "rounded-chip border border-accent-line bg-accent-surface px-3 py-2 text-sm leading-relaxed text-ink";
// Severity chips (guidance rules): a gold ramp for high→medium, green for low.
const SEV: Record<string, string> = {
  high: "border-accent-line bg-accent-fill text-accent-ink",
  medium: "border-accent-line bg-accent-soft text-accent",
  low: "border-green-line bg-green-soft text-green",
};

/**
 * The settings screen — the config ladder (wireframe #15) over the REAL `~/.rennet`
 * store. Two scopes ship, honestly:
 *   • Global: the personal appearance scheme (dark / light / system), consumed by
 *     the renderer as `data-scheme`. Side-effect-free — no repo write.
 *   • Repo: per project, the map VISIBILITY (editable — the real visibility switch
 *     writes the repo's Rennet-owned `.rennet/.gitignore`) and PROMOTION state
 *     (read-through), plus the per-repo GUIDANCE catalogue the review runners read.
 *
 * Every value shows its PROVENANCE (which ladder layer it resolved from) — the
 * resolver's own answer, never a recomputed one. The EXECUTION LOCUS (host vs a
 * named WSL distro) is a plain editable setting (add-windows-support): auto-detected
 * from the repo path, overridable, cleared back to auto with one click. The
 * remaining wireframe rows not yet consumed config (worktree location, the two
 * harness selectors) stay deliberately absent rather than faked as dead rows.
 */

const SCHEMES: readonly { id: AppearanceScheme; label: string; hint: string }[] = [
  { id: "system", label: "System", hint: "follow the OS appearance" },
  { id: "dark", label: "Dark", hint: "the glass, always dark" },
  { id: "light", label: "Light", hint: "the bright-room scheme" },
];

const VISIBILITIES: readonly { id: ProjectVisibility; label: string; hint: string }[] = [
  { id: "local", label: "Local", hint: "the derived map stays out of git" },
  { id: "git-visible", label: "Git-visible", hint: "the promoted map is stageable" },
];

/** Human label for an execution locus: "the host" or "WSL · <distro>". */
function describeLocus(locus: Locus): string {
  return locus.kind === "host" ? "the host" : `WSL · ${locus.distro}`;
}

/**
 * Explain: the value's provenance rendered as the RESOLVER's own answer — a summary
 * chip ("set here"/"detected"/"default") plus the full lowest-first list of
 * contributing layers, the effective one flagged. Never a recomputed account that
 * could disagree with the engine; the surface shows exactly what the resolver returned.
 */
function Provenance({ provenance }: { provenance: ResolvedProvenance }) {
  const setHere = provenance.layer === "global" || provenance.layer === "repo";
  const label = provenance.layer === "detected" ? "detected" : setHere ? "set here" : "default";
  return (
    <span className="settings-prov-wrap inline-flex flex-wrap items-center gap-1.5">
      <span
        className={`settings-prov rounded-chip border px-2 py-0.5 text-2xs uppercase tracking-wide ${
          setHere
            ? "settings-prov-set border-accent-line bg-accent-soft text-ink"
            : "border-line text-ink-faint"
        }`}
      >
        {label}
      </span>
      <span className="settings-prov-list inline-flex flex-wrap gap-1">
        {provenance.contributions.map((c) => (
          <span
            key={c.layer}
            className={`settings-prov-item rounded-micro border border-dashed px-1.5 py-0.5 text-2xs tracking-wide ${
              c.effective
                ? "on border-solid border-accent-line text-accent"
                : "border-line text-ink-faint"
            }`}
          >{`${c.layer}: ${c.value}`}</span>
        ))}
      </span>
    </span>
  );
}

/**
 * The Reset/Pin slot for a repo-scoped row (design Decision 5): a value explicitly
 * set at the repo layer shows Reset (drop the repo entry, inherit down the ladder);
 * an inheriting/detected value shows Pin (freeze the current effective value at the
 * repo layer). Plain reads and writes — no confirmation, no gate (Rule Zero).
 */
function ResetPin({
  layer,
  resetLabel,
  pinTitle,
  onReset,
  onPin,
  disabled,
}: {
  layer: ResolvedProvenance["layer"];
  resetLabel: string;
  pinTitle: string;
  onReset(): void;
  onPin(): void;
  disabled: boolean;
}) {
  return layer === "repo" ? (
    <Button
      variant="outline"
      className="settings-reset settings-seg-btn"
      aria-label={resetLabel}
      title="Clear the repo-layer value and inherit down the ladder"
      onClick={onReset}
      disabled={disabled}
    >
      {resetLabel}
    </Button>
  ) : (
    <Button
      variant="outline"
      className="settings-pin settings-seg-btn"
      aria-label={pinTitle}
      title={pinTitle}
      onClick={onPin}
      disabled={disabled}
    >
      Pin here
    </Button>
  );
}

export function SettingsScreen({
  bridge,
  scheme,
  onBack,
  onSchemeChange,
  onKeybindingsChange,
}: {
  bridge: RennetBridge;
  /** The resolved appearance scheme this screen renders in (system already folded). */
  scheme?: "dark" | "light";
  onBack(): void;
  /** Lets the host consume the chosen scheme app-wide (as `data-scheme`). */
  onSchemeChange?(scheme: AppearanceScheme): void;
  /** Publishes a successful Keyboard write to the app's live dispatcher state. */
  onKeybindingsChange?(overrides: KeybindingOverrides): void;
}) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<"global" | "repo" | "keyboard" | "pairing">("global");
  // A repo row is addressed by its canonical git top-level path — a workspace can
  // contribute several rows, so a bare projectId cannot key the selection.
  const [selectedRepoPath, setSelectedRepoPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    bridge
      .invoke("settings.get", {})
      .then((loaded) => {
        setView(loaded);
        const first = loaded.projects[0];
        if (first) setSelectedRepoPath((current) => current ?? first.repoPath);
      })
      .catch((reason: unknown) => setError(messageFrom(reason)));
  }, [bridge]);

  // Set a concrete scheme, or RESET to the builtin (`scheme: null`) — the global-layer
  // reset (clear the stored entry, fall back to `system`). A plain write, no ceremony.
  async function chooseScheme(scheme: AppearanceScheme | null): Promise<void> {
    if (busy || (scheme !== null && view?.scheme === scheme)) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await bridge.invoke("settings.setAppearance", { scheme });
      setView((current) =>
        current
          ? { ...current, scheme: next.scheme, schemeProvenance: next.schemeProvenance }
          : current,
      );
      onSchemeChange?.(next.scheme);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
    }
  }

  const selected = view?.projects.find((project) => project.repoPath === selectedRepoPath) ?? null;

  return (
    <div
      className="rennet-glass settings flex min-h-screen flex-col items-center bg-canvas px-6 pb-24 font-sans text-ink"
      data-scheme={scheme ?? "dark"}
    >
      <header className="settings-bar flex h-[68px] w-full max-w-[760px] items-center gap-3">
        <Button variant="outline" className="settings-back" onClick={onBack}>
          <Icon icon={ArrowLeft} className="size-3.5" />
          Back
        </Button>
        <span
          className="settings-mark grid h-8 w-8 flex-none place-items-center rounded-control border border-accent-line bg-accent-soft text-accent"
          aria-hidden="true"
        >
          <Icon icon={SlidersHorizontal} className="size-4" />
        </span>
        <h1 className="font-display text-2xl text-ink">Settings</h1>
        <span className="settings-sub ml-auto text-sm text-ink-faint">global &rsaquo; repo</span>
      </header>

      {error ? (
        <p className={`settings-error mb-3 w-full max-w-[760px] ${BANNER}`}>{error}</p>
      ) : null}

      <div className="settings-body flex w-full max-w-[760px] flex-col">
        <div className="settings-tabs mb-4 flex gap-2" role="tablist">
          <Button
            variant={tab === "global" ? "default" : "outline"}
            role="tab"
            aria-selected={tab === "global"}
            className={`settings-tab${tab === "global" ? " on" : ""}`}
            onClick={() => setTab("global")}
          >
            Global
          </Button>
          <Button
            variant={tab === "repo" ? "default" : "outline"}
            role="tab"
            aria-selected={tab === "repo"}
            className={`settings-tab${tab === "repo" ? " on" : ""}`}
            onClick={() => setTab("repo")}
          >
            Repo
          </Button>
          <Button
            variant={tab === "keyboard" ? "default" : "outline"}
            role="tab"
            aria-selected={tab === "keyboard"}
            className={`settings-tab${tab === "keyboard" ? " on" : ""}`}
            onClick={() => setTab("keyboard")}
          >
            Keyboard
          </Button>
          <Button
            variant={tab === "pairing" ? "default" : "outline"}
            role="tab"
            aria-selected={tab === "pairing"}
            className={`settings-tab${tab === "pairing" ? " on" : ""}`}
            onClick={() => setTab("pairing")}
          >
            Pairing
          </Button>
        </div>

        {view === null && !error ? (
          <p className="settings-loading mt-10 text-base text-ink-faint">Loading settings…</p>
        ) : null}

        {view !== null && tab === "global" ? (
          <section className="settings-panel flex flex-col" aria-label="Global settings">
            <div className={`settings-row ${ROW}`}>
              <div className={`settings-row-label ${ROW_LABEL}`}>
                <span className={`settings-k ${KEY}`}>Appearance</span>
                <span className={`settings-d ${DESC}`}>the scheme this machine reviews in</span>
              </div>
              <div className={`settings-row-value ${ROW_VALUE}`}>
                <fieldset
                  className="settings-seg m-0 inline-flex min-w-0 items-center gap-1 p-0"
                  aria-label="Appearance scheme"
                >
                  {SCHEMES.map((option) => (
                    <Button
                      key={option.id}
                      variant={view.scheme === option.id ? "default" : "outline"}
                      title={option.hint}
                      aria-pressed={view.scheme === option.id}
                      className={`settings-seg-btn${view.scheme === option.id ? " on" : ""}`}
                      onClick={() => void chooseScheme(option.id)}
                      disabled={busy || view.appearanceMalformed}
                    >
                      {option.label}
                    </Button>
                  ))}
                </fieldset>
                <Provenance provenance={view.schemeProvenance} />
                {view.schemeProvenance.layer === "global" ? (
                  <Button
                    variant="outline"
                    className="settings-reset settings-seg-btn"
                    aria-label="Reset appearance to the system default"
                    title="Clear the stored appearance and follow the OS again"
                    onClick={() => void chooseScheme(null)}
                    disabled={busy || view.appearanceMalformed}
                  >
                    Reset to default
                  </Button>
                ) : null}
              </div>
            </div>
            {view.appearanceMalformed ? (
              <p className={`settings-malformed mt-3 ${BANNER}`}>
                Your <code className="font-mono text-xs">~/.rennet/client-settings.json</code> could
                not be parsed. Editing is disabled so it is not overwritten — fix or remove the
                file, then reopen settings.
              </p>
            ) : (
              <p className="settings-note mt-3 text-sm text-ink-faint">
                A personal preference, stored on this machine only. It never leaves it and never
                touches a repository.
              </p>
            )}
            <GitHubAccountRows bridge={bridge} />
          </section>
        ) : null}

        {view !== null && tab === "repo" ? (
          view.projects.length === 0 ? (
            <section className="settings-panel flex flex-col">
              <div className="settings-empty flex flex-col items-center gap-4 py-10 text-center text-ink-faint">
                <span className="settings-empty-mark text-accent opacity-70" aria-hidden="true">
                  <RennetBrandMark size={22} />
                </span>
                <p className="text-base">
                  No projects yet. Add one from the front door to configure it here.
                </p>
              </div>
            </section>
          ) : (
            <RepoPanel
              bridge={bridge}
              projects={view.projects}
              selected={selected}
              selectedRepoPath={selectedRepoPath}
              onSelect={setSelectedRepoPath}
              onVisibilityResolved={(repoPath, visibility) =>
                setView((current) =>
                  current
                    ? {
                        ...current,
                        projects: current.projects.map((project) =>
                          project.repoPath === repoPath
                            ? {
                                ...project,
                                visibility,
                                visibilityProvenance: {
                                  layer: "repo",
                                  contributions: [
                                    { layer: "builtin", value: "local", effective: false },
                                    { layer: "repo", value: visibility, effective: true },
                                  ],
                                },
                              }
                            : project,
                        ),
                      }
                    : current,
                )
              }
              onRowReplaced={(next) =>
                setView((current) =>
                  current
                    ? {
                        ...current,
                        projects: current.projects.map((project) =>
                          project.repoPath === next.repoPath ? next : project,
                        ),
                      }
                    : current,
                )
              }
            />
          )
        ) : null}

        {view !== null && tab === "keyboard" ? (
          <KeyboardPanel
            bridge={bridge}
            overrides={view.keybindings ?? {}}
            malformed={view.appearanceMalformed}
            onOverridesChanged={(keybindings) => {
              setView((current) => (current ? { ...current, keybindings } : current));
              onKeybindingsChange?.(keybindings);
            }}
          />
        ) : null}

        {view !== null && tab === "pairing" ? <PairingPanel bridge={bridge} /> : null}
      </div>
    </div>
  );
}

/**
 * The Pairing section (#380) — mint a device pairing code and manage paired devices.
 * A minted code is a typed one-time bootstrap (5-minute TTL); a device exchanges it
 * once for a long-lived token and then just works — no per-action ceremony (Rule Zero).
 * QR rendering is deferred (no dependency added this phase, per the Dependency
 * Standard); the typed code is the whole UX and works over any transport. All state
 * goes through `bridge.invoke` — no host effects.
 */
function PairingPanel({ bridge }: { bridge: RennetBridge }) {
  const [devices, setDevices] = useState<
    { deviceId: string; name: string; lastSeenAt: string; expiresAt: string }[]
  >([]);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    bridge
      .invoke("pairing.listDevices", {})
      .then((result) => setDevices(result.devices))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [bridge]);

  async function mint(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setCode(await bridge.invoke("pairing.mint", {}));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(deviceId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await bridge.invoke("pairing.revokeDevice", { deviceId });
      setDevices(result.devices);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-panel flex flex-col" aria-label="Device pairing">
      {error ? <p className={`settings-error ${BANNER}`}>{error}</p> : null}
      <div className={`settings-row ${ROW}`}>
        <div className={`settings-row-label ${ROW_LABEL}`}>
          <span className={`settings-k ${KEY}`}>Pair a device</span>
          <span className={`settings-d ${DESC}`}>
            a one-time code a remote device exchanges for access
          </span>
        </div>
        <div className={`settings-row-value ${ROW_VALUE}`}>
          <Button
            variant="outline"
            className="settings-seg-btn"
            onClick={() => void mint()}
            disabled={busy}
          >
            Create pairing code
          </Button>
          {code ? (
            <div className="settings-pair-code mt-2 flex flex-col gap-1" aria-live="polite">
              <code className="settings-pair-code-value self-start rounded-chip border border-line bg-code px-3 py-1.5 font-mono text-lg tracking-[0.15em]">
                {code.code}
              </code>
              <span className={`settings-d ${DESC}`}>
                enter it on the device within 5 minutes; it works once
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className={`settings-row ${ROW}`}>
        <div className={`settings-row-label ${ROW_LABEL}`}>
          <span className={`settings-k ${KEY}`}>Paired devices</span>
          <span className={`settings-d ${DESC}`}>
            revoke a device to end its access at the next handshake
          </span>
        </div>
        <div className={`settings-row-value ${ROW_VALUE}`}>
          {devices.length === 0 ? (
            <p className="settings-note text-sm text-ink-faint">No devices paired yet.</p>
          ) : (
            <ul className="settings-pair-list m-0 mt-2 flex list-none flex-col gap-2 p-0">
              {devices.map((device) => (
                <li key={device.deviceId} className="settings-pair-item flex items-center gap-3">
                  <span className={`settings-k ${KEY}`}>{device.name}</span>
                  <span className={`settings-d ${DESC}`}>last seen {device.lastSeenAt}</span>
                  <Button
                    variant="outline"
                    className="settings-seg-btn"
                    aria-label={`Revoke ${device.name}`}
                    onClick={() => void revoke(device.deviceId)}
                    disabled={busy}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className={`settings-note ${NOTE}`}>
        A paired device reaches this daemon directly (Tailscale-first) — there is no Rennet server
        in the middle. A remote device never sees a host path; it works with repo references only.
      </p>
    </section>
  );
}

/** The static-title label for a catalogue row (context-independent surface). */
function catalogueLabel(def: CommandDef): string {
  return typeof def.title === "string" ? def.title : def.id;
}

/**
 * The Keyboard section (#44) — every catalogued command, each with its EFFECTIVE
 * binding and plain set / unbind / reset
 * controls that write straight through `settings.setKeybinding` (first click, no
 * confirmation). A chord claimed by more than one command is disclosed inline on both
 * rows; the conflicting write is still accepted and persisted — disclosure is the whole
 * intervention (Rule Zero). Context-independent, so it renders outside the workspace.
 */
function KeyboardPanel({
  bridge,
  overrides,
  malformed,
  onOverridesChanged,
}: {
  bridge: RennetBridge;
  overrides: KeybindingOverrides;
  malformed: boolean;
  onOverridesChanged(overrides: KeybindingOverrides): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The row currently capturing its next keydown as a new chord (the recorder).
  const [recording, setRecording] = useState<string | null>(null);
  const [recordingNote, setRecordingNote] = useState<string>();

  const rows = COMMAND_CATALOGUE;
  const knownIds = new Set(rows.map((def) => def.id));
  const unknownOverrides = Object.entries(overrides).filter(([id]) => !knownIds.has(id));
  const conflicts = findConflicts(rows, overrides);
  const labelById = new Map(rows.map((def) => [def.id, catalogueLabel(def)]));

  async function write(id: string, keybinding: string | null | undefined): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // `keybinding` omitted (undefined) is RESET; the bridge input drops the key.
      const next = await bridge.invoke(
        "settings.setKeybinding",
        keybinding === undefined ? { id } : { id, keybinding },
      );
      onOverridesChanged(next.keybindings);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
      setRecording(null);
      setRecordingNote(undefined);
    }
  }

  // The recorder: the next keydown becomes the new chord token (`mod+e`, `j`). Escape
  // cancels without a write. A plain capture — no modal, no confirmation step.
  function onRecordKey(id: string, event: React.KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    setRecordingNote(undefined);
    if (event.key === "Escape") {
      setRecording(null);
      return;
    }
    // Ignore a lone modifier press — wait for the real key.
    if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return;
    if (event.shiftKey || event.altKey) {
      setRecordingNote("Shift and Alt combinations are not supported.");
      return;
    }
    const chord = chordFromEvent(event);
    if (chord.unsupported) {
      setRecordingNote("Use the platform primary modifier for modified shortcuts.");
      return;
    }
    const token = `${chord.mod ? "mod+" : ""}${chord.key}`;
    if (!normalizeChord(token)) {
      setRecordingNote("That key is not supported by the v1 chord grammar.");
      return;
    }
    void write(id, token);
  }

  return (
    <section
      className="settings-panel settings-keyboard flex flex-col"
      aria-label="Keyboard settings"
    >
      {error ? <p className={`settings-error ${BANNER}`}>{error}</p> : null}
      {malformed ? (
        <p className={`settings-malformed mt-3 ${BANNER}`}>
          Your <code className="font-mono text-xs">~/.rennet/client-settings.json</code> could not
          be parsed. Editing is disabled so it is not overwritten — fix or remove the file, then
          reopen settings.
        </p>
      ) : (
        <p className="settings-note text-sm text-ink-faint">
          Remap any command. Overrides are stored on this machine only and survive restart. Two
          commands may share a chord — the collision is shown, never blocked; the first match wins.
        </p>
      )}
      <ul className="settings-keys m-0 mt-1 flex list-none flex-col p-0">
        {rows.map((def) => {
          const rawOverride = overrides[def.id];
          const invalidOverride = typeof rawOverride === "string" && !normalizeChord(rawOverride);
          const token = effectiveKeybinding(def, overrides);
          const chord = token ? normalizeChord(token) : null;
          const chordKey = chord ? `${chord.mod ? "mod+" : ""}${chord.key}` : null;
          const colliding = chordKey ? conflicts.get(chordKey) : undefined;
          const others = colliding?.filter((other) => other !== def.id) ?? [];
          const overridden = overrides[def.id] !== undefined;
          return (
            <li
              key={def.id}
              className="settings-key-row flex items-center justify-between gap-3 border-b border-line py-2"
            >
              <div className={`settings-row-label ${ROW_LABEL}`}>
                <span className={`settings-k ${KEY}`}>{catalogueLabel(def)}</span>
                <span className={`settings-d ${DESC}`}>{def.group}</span>
              </div>
              <div className="settings-row-value settings-key-value flex flex-wrap items-center justify-end gap-2">
                {recording === def.id ? (
                  <Input
                    type="text"
                    readOnly
                    // Focus on mount so the very next keystroke is captured as the chord.
                    ref={(node) => node?.focus()}
                    className="settings-key-recorder w-32 border-accent-line"
                    aria-label={`Press the new chord for ${catalogueLabel(def)}`}
                    placeholder="Press a chord…"
                    onKeyDown={(event) => onRecordKey(def.id, event)}
                    onBlur={() => {
                      setRecording(null);
                      setRecordingNote(undefined);
                    }}
                  />
                ) : token ? (
                  <kbd
                    className={`command-palette-key rounded-chip border px-2 py-0.5 font-sans text-xs ${
                      others.length > 0
                        ? "is-conflict border-accent-line bg-raised text-ink"
                        : "border-line bg-raised text-ink-soft"
                    }`}
                    title={
                      others.length > 0
                        ? `Also bound to ${others.map((id) => labelById.get(id) ?? id).join(", ")}`
                        : undefined
                    }
                    data-conflict={others.length > 0 ? "true" : undefined}
                  >
                    {formatKeybinding(token)}
                  </kbd>
                ) : (
                  <span className="settings-key-unbound text-sm italic text-ink-faint">
                    unbound
                  </span>
                )}
                {recording === def.id && recordingNote ? (
                  <span className="settings-key-recording-note text-xs text-accent">
                    {recordingNote}
                  </span>
                ) : null}
                {invalidOverride ? (
                  <span className="settings-key-invalid text-xs text-accent">
                    Invalid stored chord: <code className="font-mono">{rawOverride}</code>;{" "}
                    {def.keybinding ? "using the default." : "no shortcut is active."}
                  </span>
                ) : null}
                {others.length > 0 ? (
                  <span className="settings-key-conflict text-xs text-accent">
                    conflicts with {others.map((id) => labelById.get(id) ?? id).join(", ")}
                  </span>
                ) : null}
                <span className="settings-key-controls inline-flex gap-1">
                  <Button
                    variant="outline"
                    className="settings-seg-btn"
                    onClick={() => {
                      setRecordingNote(undefined);
                      setRecording(def.id);
                    }}
                    disabled={busy || malformed}
                  >
                    Set
                  </Button>
                  <Button
                    variant="outline"
                    className="settings-seg-btn"
                    onClick={() => void write(def.id, null)}
                    disabled={busy || malformed}
                  >
                    Unbind
                  </Button>
                  {overridden ? (
                    <Button
                      variant="outline"
                      className="settings-seg-btn"
                      onClick={() => void write(def.id, undefined)}
                      disabled={busy || malformed}
                    >
                      Reset
                    </Button>
                  ) : null}
                </span>
              </div>
            </li>
          );
        })}
        {unknownOverrides.map(([id, raw]) => (
          <li
            key={id}
            className="settings-key-row settings-key-unknown flex items-center justify-between gap-3 border-b border-line py-2"
          >
            <div className={`settings-row-label ${ROW_LABEL}`}>
              <span className={`settings-k ${KEY}`}>{id}</span>
              <span className={`settings-d ${DESC}`}>Unknown command</span>
            </div>
            <div className="settings-row-value settings-key-value flex flex-wrap items-center justify-end gap-2">
              <code className="font-mono text-sm text-ink-soft">
                {raw === null ? "unbound" : raw}
              </code>
              <span className="settings-key-controls inline-flex gap-1">
                <Button
                  variant="outline"
                  className="settings-seg-btn"
                  onClick={() => void write(id, undefined)}
                  disabled={busy || malformed}
                >
                  Reset
                </Button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The repo scope: a repo picker + the selected repo's ladder + guidance. */
function RepoPanel({
  bridge,
  projects,
  selected,
  selectedRepoPath,
  onSelect,
  onVisibilityResolved,
  onRowReplaced,
}: {
  bridge: RennetBridge;
  projects: readonly SettingsProject[];
  selected: SettingsProject | null;
  selectedRepoPath: string | null;
  onSelect(repoPath: string): void;
  onVisibilityResolved(repoPath: string, visibility: ProjectVisibility): void;
  /** Replace a whole row with the resolver's freshly re-resolved answer. */
  onRowReplaced(project: SettingsProject): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [guidance, setGuidance] = useState<SettingsGuidance | null>(null);

  const selectedProjectId = selected?.projectId;
  useEffect(() => {
    if (!selectedProjectId || !selectedRepoPath) return;
    setGuidance(null);
    setNote(undefined);
    bridge
      .invoke("settings.guidance", { projectId: selectedProjectId, repoPath: selectedRepoPath })
      .then(setGuidance)
      .catch(() => setGuidance({ rules: [], reason: "unreadable", dropped: 0 }));
  }, [bridge, selectedProjectId, selectedRepoPath]);

  async function chooseVisibility(visibility: ProjectVisibility): Promise<void> {
    if (!selected || busy || selected.visibility === visibility || selected.configMalformed) return;
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const result = await bridge.invoke("settings.setRepoVisibility", {
        commandId: crypto.randomUUID(),
        projectId: selected.projectId,
        repoPath: selected.repoPath,
        visibility,
      });
      // Only a genuine apply mutates the row — an unresolved checkout or a
      // refused-because-malformed config leaves the surface untouched (no false
      // "success"), with target-neutral copy that never claims a write happened.
      if (result.status === "applied") {
        onVisibilityResolved(selected.repoPath, result.visibility);
        setNote(
          result.changed
            ? `Updated ${result.gitignorePath}`
            : "No .gitignore change was needed for that setting.",
        );
      } else if (result.status === "unresolved") {
        setError("This repository could not be resolved — nothing was changed.");
      } else {
        setError("This repository's config is malformed — the change was refused to protect it.");
      }
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
    }
  }

  // Reset (drop the repo-layer entry, inherit) and Pin (freeze the current effective
  // value at the repo layer). Both re-render the row from the resolver's own answer
  // returned by the command — never a hand-recomputed provenance. A `status` other
  // than `applied` means nothing was written, so the surface says so and stays put.
  async function resetPin(
    command: "settings.resetRepoValue" | "settings.pinRepoValue",
    key: SettingsRepoValueKey,
  ): Promise<void> {
    if (!selected || busy || selected.configMalformed) return;
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const result = await bridge.invoke(command, {
        projectId: selected.projectId,
        repoPath: selected.repoPath,
        key,
      });
      if (result.status === "applied" && result.project) {
        onRowReplaced(result.project);
        setNote(
          command === "settings.resetRepoValue"
            ? "Reset to the inherited value."
            : "Pinned the current value at this repo.",
        );
      } else if (result.status === "unresolved") {
        setError("This repository could not be resolved — nothing was changed.");
      } else {
        setError("This repository's config is malformed — the change was refused to protect it.");
      }
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-panel flex flex-col" aria-label="Repository settings">
      <div
        className="settings-picker mb-2 flex flex-wrap gap-2 border-b border-line py-3"
        role="tablist"
        aria-label="Repository"
      >
        {projects.map((project) => (
          <Button
            key={project.repoPath}
            variant={project.repoPath === selectedRepoPath ? "default" : "outline"}
            role="tab"
            aria-selected={project.repoPath === selectedRepoPath}
            className={`settings-pick${project.repoPath === selectedRepoPath ? " on" : ""}`}
            onClick={() => onSelect(project.repoPath)}
          >
            {project.name}
          </Button>
        ))}
      </div>

      {selected ? (
        <>
          <div className={`settings-row ${ROW}`}>
            <div className={`settings-row-label ${ROW_LABEL}`}>
              <span className={`settings-k ${KEY}`}>Map visibility</span>
              <span className={`settings-d ${DESC}`}>
                whether the derived map is visible to git
              </span>
            </div>
            <div className={`settings-row-value ${ROW_VALUE}`}>
              <fieldset
                className="settings-seg m-0 inline-flex min-w-0 items-center gap-1 p-0"
                aria-label="Map visibility"
              >
                {VISIBILITIES.map((option) => (
                  <Button
                    key={option.id}
                    variant={selected.visibility === option.id ? "default" : "outline"}
                    title={option.hint}
                    aria-pressed={selected.visibility === option.id}
                    className={`settings-seg-btn${selected.visibility === option.id ? " on" : ""}`}
                    onClick={() => void chooseVisibility(option.id)}
                    disabled={busy || selected.configMalformed}
                  >
                    {option.label}
                  </Button>
                ))}
              </fieldset>
              <Provenance provenance={selected.visibilityProvenance} />
              <ResetPin
                layer={selected.visibilityProvenance.layer}
                resetLabel="Reset to inherit"
                pinTitle="Pin the map visibility at its current value"
                onReset={() => void resetPin("settings.resetRepoValue", "visibility")}
                onPin={() => void resetPin("settings.pinRepoValue", "visibility")}
                disabled={busy || selected.configMalformed}
              />
            </div>
          </div>

          <div className={`settings-row ${ROW}`}>
            <div className={`settings-row-label ${ROW_LABEL}`}>
              <span className={`settings-k ${KEY}`}>Map promotion</span>
              <span className={`settings-d ${DESC}`}>is the base map mirrored into the repo</span>
            </div>
            <div className={`settings-row-value ${ROW_VALUE}`}>
              <span className="settings-readthrough text-base text-ink-soft">
                {selected.promoted ? "Promoted" : "Not promoted"}
              </span>
              <Provenance provenance={selected.promotedProvenance} />
            </div>
          </div>

          <div className={`settings-row ${ROW}`}>
            <div className={`settings-row-label ${ROW_LABEL}`}>
              <span className={`settings-k ${KEY}`}>Runs on</span>
              <span className={`settings-d ${DESC}`}>
                where git and the harness run — detected from the repo path, not a choice
              </span>
            </div>
            <div className={`settings-row-value ${ROW_VALUE}`}>
              {/* A DETECTED FACT, not a knob (#476): Rennet shows where the harness runs. */}
              <span className="settings-readthrough text-base text-ink-soft">
                {describeLocus(selected.locus)} (detected)
              </span>
              <Provenance provenance={selected.locusProvenance} />
            </div>
          </div>

          {selected.configMalformed ? (
            <p className={`settings-malformed mt-3 ${BANNER}`}>
              This repository's <code className="font-mono text-xs">~/.rennet</code> config could
              not be parsed. It shows built-in defaults and editing is disabled so the file is not
              overwritten.
            </p>
          ) : null}
          {note ? <p className="settings-applied mt-3 text-sm text-accent">{note}</p> : null}
          {error ? (
            <p className={`settings-error settings-error-inline mt-2 ${BANNER}`}>{error}</p>
          ) : null}

          <Guidance guidance={guidance} />
        </>
      ) : null}
    </section>
  );
}

/** The per-repo guidance panel: the house rules the harness reads before every review. */
function Guidance({ guidance }: { guidance: SettingsGuidance | null }) {
  return (
    <div className="settings-guidance mt-4 flex flex-col gap-2">
      <div className="settings-guidance-h text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        Per-repo guidance &middot; .rennet/conventions.json
      </div>
      <div className="settings-guidance-b flex flex-col">
        {guidance === null ? (
          <p className="settings-guidance-empty text-sm text-ink-faint">Loading guidance…</p>
        ) : guidance.rules.length === 0 ? (
          <p className="settings-guidance-empty text-sm text-ink-faint">
            {guidance.reason === "absent"
              ? "No guidance file. The review runs on its built-in checklist."
              : guidance.reason === "unreadable"
                ? "The guidance file could not be read; the review runs on its built-in checklist."
                : "No valid rules in the guidance file yet."}
          </p>
        ) : (
          <>
            <p className="settings-guidance-lede mb-2 text-sm text-ink-soft">
              The house rules the review runners read before every review.
            </p>
            <ul className="settings-rules m-0 flex list-none flex-col gap-3 p-0">
              {guidance.rules.map((rule) => (
                <li
                  key={`${rule.convention}::${rule.rationale}`}
                  className="settings-rule flex items-start gap-3"
                >
                  <span
                    className={`settings-sev settings-sev-${rule.severity} mt-0.5 flex-none rounded-chip border px-2 py-0.5 text-2xs uppercase tracking-wide ${
                      SEV[rule.severity] ?? "border-line text-ink-faint"
                    }`}
                  >
                    {rule.severity}
                  </span>
                  <div className="settings-rule-body flex flex-col gap-0.5">
                    <span className="settings-rule-k text-base font-semibold text-ink">
                      {rule.convention}
                    </span>
                    <span className="settings-rule-why text-sm text-ink-soft">
                      {rule.rationale}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            {guidance.dropped > 0 ? (
              <p className="settings-guidance-dropped mt-3 text-sm text-ink-faint">
                {guidance.dropped} malformed {guidance.dropped === 1 ? "rule was" : "rules were"}{" "}
                dropped.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
