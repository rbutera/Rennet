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
import { useEffect, useState } from "react";
import {
  chordFromEvent,
  COMMAND_CATALOGUE,
  type CommandDef,
  effectiveKeybinding,
  findConflicts,
  formatKeybinding,
  type KeybindingOverrides,
  normalizeChord,
} from "../command/commands";
import { ArrowLeftIcon, RennetMark, SlidersIcon } from "./icons";

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

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

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
    <span className="settings-prov-wrap">
      <span className={`settings-prov${setHere ? " settings-prov-set" : ""}`}>{label}</span>
      <span className="settings-prov-list">
        {provenance.contributions.map((c) => (
          <span
            key={c.layer}
            className={`settings-prov-item${c.effective ? " on" : ""}`}
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
    <button
      type="button"
      className="settings-reset settings-seg-btn"
      aria-label={resetLabel}
      title="Clear the repo-layer value and inherit down the ladder"
      onClick={onReset}
      disabled={disabled}
    >
      {resetLabel}
    </button>
  ) : (
    <button
      type="button"
      className="settings-pin settings-seg-btn"
      aria-label={pinTitle}
      title={pinTitle}
      onClick={onPin}
      disabled={disabled}
    >
      Pin here
    </button>
  );
}

export function SettingsScreen({
  bridge,
  scheme,
  onBack,
  onSchemeChange,
}: {
  bridge: RennetBridge;
  /** The resolved appearance scheme this screen renders in (system already folded). */
  scheme?: "dark" | "light";
  onBack(): void;
  /** Lets the host consume the chosen scheme app-wide (as `data-scheme`). */
  onSchemeChange?(scheme: AppearanceScheme): void;
}) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<"global" | "repo" | "keyboard">("global");
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
    <div className="rennet-glass settings" data-scheme={scheme ?? "dark"}>
      <header className="settings-bar">
        <button type="button" className="settings-back" onClick={onBack}>
          <ArrowLeftIcon size={13} />
          Back
        </button>
        <span className="settings-mark" aria-hidden="true">
          <SlidersIcon size={16} />
        </span>
        <h1>Settings</h1>
        <span className="settings-sub">global &rsaquo; repo</span>
      </header>

      {error ? <p className="settings-error">{error}</p> : null}

      <div className="settings-body">
        <div className="settings-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "global"}
            className={`settings-tab${tab === "global" ? " on" : ""}`}
            onClick={() => setTab("global")}
          >
            Global
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "repo"}
            className={`settings-tab${tab === "repo" ? " on" : ""}`}
            onClick={() => setTab("repo")}
          >
            Repo
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "keyboard"}
            className={`settings-tab${tab === "keyboard" ? " on" : ""}`}
            onClick={() => setTab("keyboard")}
          >
            Keyboard
          </button>
        </div>

        {view === null && !error ? <p className="settings-loading">Loading settings…</p> : null}

        {view !== null && tab === "global" ? (
          <section className="settings-panel" aria-label="Global settings">
            <div className="settings-row">
              <div className="settings-row-label">
                <span className="settings-k">Appearance</span>
                <span className="settings-d">the scheme this machine reviews in</span>
              </div>
              <div className="settings-row-value">
                <fieldset className="settings-seg" aria-label="Appearance scheme">
                  {SCHEMES.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      title={option.hint}
                      aria-pressed={view.scheme === option.id}
                      className={`settings-seg-btn${view.scheme === option.id ? " on" : ""}`}
                      onClick={() => void chooseScheme(option.id)}
                      disabled={busy || view.appearanceMalformed}
                    >
                      {option.label}
                    </button>
                  ))}
                </fieldset>
                <Provenance provenance={view.schemeProvenance} />
                {view.schemeProvenance.layer === "global" ? (
                  <button
                    type="button"
                    className="settings-reset settings-seg-btn"
                    aria-label="Reset appearance to the system default"
                    title="Clear the stored appearance and follow the OS again"
                    onClick={() => void chooseScheme(null)}
                    disabled={busy || view.appearanceMalformed}
                  >
                    Reset to default
                  </button>
                ) : null}
              </div>
            </div>
            {view.appearanceMalformed ? (
              <p className="settings-malformed">
                Your <code>~/.rennet/config.json</code> could not be parsed. Editing is disabled so
                it is not overwritten — fix or remove the file, then reopen settings.
              </p>
            ) : (
              <p className="settings-note">
                A personal preference, stored on this machine only. It never leaves it and never
                touches a repository.
              </p>
            )}
          </section>
        ) : null}

        {view !== null && tab === "repo" ? (
          view.projects.length === 0 ? (
            <section className="settings-panel">
              <div className="settings-empty">
                <span className="settings-empty-mark" aria-hidden="true">
                  <RennetMark size={26} />
                </span>
                <p>No projects yet. Add one from the front door to configure it here.</p>
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
            onOverridesChanged={(keybindings) =>
              setView((current) => (current ? { ...current, keybindings } : current))
            }
          />
        ) : null}
      </div>
    </div>
  );
}

/** The static-title label for a catalogue row (context-independent surface). */
function catalogueLabel(def: CommandDef): string {
  return typeof def.title === "string" ? def.title : def.id;
}

/**
 * The Keyboard section (#44) — every catalogued command that has a default chord or a
 * stored override, each with its EFFECTIVE binding and plain set / unbind / reset
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

  const rows = COMMAND_CATALOGUE.filter(
    (def) => def.keybinding !== undefined || overrides[def.id] !== undefined,
  );
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
    }
  }

  // The recorder: the next keydown becomes the new chord token (`mod+e`, `j`). Escape
  // cancels without a write. A plain capture — no modal, no confirmation step.
  function onRecordKey(id: string, event: React.KeyboardEvent): void {
    event.preventDefault();
    if (event.key === "Escape") {
      setRecording(null);
      return;
    }
    // Ignore a lone modifier press — wait for the real key.
    if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return;
    const chord = chordFromEvent(event);
    const token = `${chord.mod ? "mod+" : ""}${chord.key}`;
    void write(id, token);
  }

  return (
    <section className="settings-panel settings-keyboard" aria-label="Keyboard settings">
      {error ? <p className="settings-error">{error}</p> : null}
      {malformed ? (
        <p className="settings-malformed">
          Your <code>~/.rennet/config.json</code> could not be parsed. Editing is disabled so it is
          not overwritten — fix or remove the file, then reopen settings.
        </p>
      ) : (
        <p className="settings-note">
          Remap any command. Overrides are stored on this machine only and survive restart. Two
          commands may share a chord — the collision is shown, never blocked; the later match wins.
        </p>
      )}
      <ul className="settings-keys">
        {rows.map((def) => {
          const token = effectiveKeybinding(def, overrides);
          const chord = token ? normalizeChord(token) : null;
          const chordKey = chord ? `${chord.mod ? "mod+" : ""}${chord.key}` : null;
          const colliding = chordKey ? conflicts.get(chordKey) : undefined;
          const others = colliding?.filter((other) => other !== def.id) ?? [];
          const overridden = overrides[def.id] !== undefined;
          return (
            <li key={def.id} className="settings-key-row">
              <div className="settings-row-label">
                <span className="settings-k">{catalogueLabel(def)}</span>
                <span className="settings-d">{def.group}</span>
              </div>
              <div className="settings-row-value settings-key-value">
                {recording === def.id ? (
                  // biome-ignore lint/a11y/noStaticElementInteractions: a transient chord recorder — the focused capture field IS the control, dismissed by Escape or a captured key.
                  <input
                    type="text"
                    readOnly
                    autoFocus
                    className="settings-key-recorder"
                    aria-label={`Press the new chord for ${catalogueLabel(def)}`}
                    placeholder="Press a chord…"
                    onKeyDown={(event) => onRecordKey(def.id, event)}
                    onBlur={() => setRecording(null)}
                  />
                ) : token ? (
                  <kbd
                    className={`command-palette-key${others.length > 0 ? " is-conflict" : ""}`}
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
                  <span className="settings-key-unbound">unbound</span>
                )}
                {others.length > 0 ? (
                  <span className="settings-key-conflict">
                    conflicts with {others.map((id) => labelById.get(id) ?? id).join(", ")}
                  </span>
                ) : null}
                <span className="settings-key-controls">
                  <button
                    type="button"
                    className="settings-seg-btn"
                    onClick={() => setRecording(def.id)}
                    disabled={busy || malformed}
                  >
                    Set
                  </button>
                  <button
                    type="button"
                    className="settings-seg-btn"
                    onClick={() => void write(def.id, null)}
                    disabled={busy || malformed}
                  >
                    Unbind
                  </button>
                  {overridden ? (
                    <button
                      type="button"
                      className="settings-seg-btn"
                      onClick={() => void write(def.id, undefined)}
                      disabled={busy || malformed}
                    >
                      Reset
                    </button>
                  ) : null}
                </span>
              </div>
            </li>
          );
        })}
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
  const [distroInput, setDistroInput] = useState("");

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

  // The execution locus is a plain editable setting (add-windows-support, Rule Zero
  // — never a gate): override to host, override to a named WSL distro, or clear the
  // override back to the value auto-detected from the repo path.
  async function chooseLocus(locus: Locus | null): Promise<void> {
    if (!selected || busy || selected.configMalformed) return;
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const result = await bridge.invoke("settings.setRepoLocus", {
        projectId: selected.projectId,
        repoPath: selected.repoPath,
        locus,
      });
      if (result.status === "applied") {
        onRowReplaced(result.project);
        setDistroInput("");
        setNote(
          result.project.locusOverridden
            ? `Execution locus set to ${describeLocus(result.project.locus)}.`
            : "Execution locus reset to the auto-detected value.",
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
    <section className="settings-panel" aria-label="Repository settings">
      <div className="settings-picker" role="tablist" aria-label="Repository">
        {projects.map((project) => (
          <button
            key={project.repoPath}
            type="button"
            role="tab"
            aria-selected={project.repoPath === selectedRepoPath}
            className={`settings-pick${project.repoPath === selectedRepoPath ? " on" : ""}`}
            onClick={() => onSelect(project.repoPath)}
          >
            {project.name}
          </button>
        ))}
      </div>

      {selected ? (
        <>
          <div className="settings-row">
            <div className="settings-row-label">
              <span className="settings-k">Map visibility</span>
              <span className="settings-d">whether the derived map is visible to git</span>
            </div>
            <div className="settings-row-value">
              <fieldset className="settings-seg" aria-label="Map visibility">
                {VISIBILITIES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    title={option.hint}
                    aria-pressed={selected.visibility === option.id}
                    className={`settings-seg-btn${selected.visibility === option.id ? " on" : ""}`}
                    onClick={() => void chooseVisibility(option.id)}
                    disabled={busy || selected.configMalformed}
                  >
                    {option.label}
                  </button>
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

          <div className="settings-row">
            <div className="settings-row-label">
              <span className="settings-k">Map promotion</span>
              <span className="settings-d">is the base map mirrored into the repo</span>
            </div>
            <div className="settings-row-value">
              <span className="settings-readthrough">
                {selected.promoted ? "Promoted" : "Not promoted"}
              </span>
              <Provenance provenance={selected.promotedProvenance} />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-label">
              <span className="settings-k">Execution locus</span>
              <span className="settings-d">
                where git and the harness run — the host, or a WSL distro
              </span>
            </div>
            <div className="settings-row-value">
              <span className="settings-readthrough">
                {describeLocus(selected.locus)}
                {selected.locusOverridden ? "" : " (auto-detected)"}
              </span>
              <fieldset className="settings-seg" aria-label="Execution locus">
                <button
                  type="button"
                  title="Run git and the harness on the host OS"
                  aria-pressed={selected.locus.kind === "host"}
                  className={`settings-seg-btn${selected.locus.kind === "host" ? " on" : ""}`}
                  onClick={() => void chooseLocus({ kind: "host" })}
                  disabled={busy || selected.configMalformed}
                >
                  Host
                </button>
              </fieldset>
              <Provenance provenance={selected.locusProvenance} />
              <ResetPin
                layer={selected.locusProvenance.layer}
                resetLabel="Reset to auto"
                pinTitle="Pin the execution locus at its detected value"
                onReset={() => void resetPin("settings.resetRepoValue", "locus")}
                onPin={() => void resetPin("settings.pinRepoValue", "locus")}
                disabled={busy || selected.configMalformed}
              />
              <div className="settings-locus-distro">
                <input
                  type="text"
                  aria-label="WSL distro name"
                  placeholder="WSL distro (e.g. Ubuntu)"
                  value={distroInput}
                  onChange={(event) => setDistroInput(event.target.value)}
                  disabled={busy || selected.configMalformed}
                />
                <button
                  type="button"
                  className="settings-seg-btn"
                  onClick={() => void chooseLocus({ kind: "wsl", distro: distroInput.trim() })}
                  disabled={busy || selected.configMalformed || distroInput.trim().length === 0}
                >
                  Use WSL distro
                </button>
              </div>
            </div>
          </div>

          {selected.configMalformed ? (
            <p className="settings-malformed">
              This repository's <code>~/.rennet</code> config could not be parsed. It shows built-in
              defaults and editing is disabled so the file is not overwritten.
            </p>
          ) : null}
          {note ? <p className="settings-applied">{note}</p> : null}
          {error ? <p className="settings-error settings-error-inline">{error}</p> : null}

          <Guidance guidance={guidance} />
        </>
      ) : null}
    </section>
  );
}

/** The per-repo guidance panel: the house rules the harness reads before every review. */
function Guidance({ guidance }: { guidance: SettingsGuidance | null }) {
  return (
    <div className="settings-guidance">
      <div className="settings-guidance-h">Per-repo guidance &middot; .rennet/conventions.json</div>
      <div className="settings-guidance-b">
        {guidance === null ? (
          <p className="settings-guidance-empty">Loading guidance…</p>
        ) : guidance.rules.length === 0 ? (
          <p className="settings-guidance-empty">
            {guidance.reason === "absent"
              ? "No guidance file. The review runs on its built-in checklist."
              : guidance.reason === "unreadable"
                ? "The guidance file could not be read; the review runs on its built-in checklist."
                : "No valid rules in the guidance file yet."}
          </p>
        ) : (
          <>
            <p className="settings-guidance-lede">
              The house rules the review runners read before every review.
            </p>
            <ul className="settings-rules">
              {guidance.rules.map((rule) => (
                <li key={`${rule.convention}::${rule.rationale}`} className="settings-rule">
                  <span className={`settings-sev settings-sev-${rule.severity}`}>
                    {rule.severity}
                  </span>
                  <div className="settings-rule-body">
                    <span className="settings-rule-k">{rule.convention}</span>
                    <span className="settings-rule-why">{rule.rationale}</span>
                  </div>
                </li>
              ))}
            </ul>
            {guidance.dropped > 0 ? (
              <p className="settings-guidance-dropped">
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
