import type {
  AppearanceScheme,
  ProjectVisibility,
  RennetBridge,
  ResolvedProvenance,
  SettingsGuidance,
  SettingsProject,
  SettingsView,
} from "@rennet/protocol";
import { useEffect, useState } from "react";
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
 * resolver's own answer, never a recomputed one. The four wireframe rows that do
 * not exist as consumed config yet (execution mode, worktree location, the two
 * harness selectors) are deliberately absent rather than faked as dead rows.
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

/** The provenance chip: where a value resolved from, in the ladder's own words. */
function Provenance({ provenance }: { provenance: ResolvedProvenance }) {
  const setHere = provenance.layer !== "builtin";
  const label = setHere ? "set here" : "default";
  return <span className={`settings-prov${setHere ? " settings-prov-set" : ""}`}>{label}</span>;
}

export function SettingsScreen({
  bridge,
  onBack,
  onSchemeChange,
}: {
  bridge: RennetBridge;
  onBack(): void;
  /** Lets the host consume the chosen scheme app-wide (as `data-scheme`). */
  onSchemeChange?(scheme: AppearanceScheme): void;
}) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<"global" | "repo">("global");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    bridge
      .invoke("settings.get", {})
      .then((loaded) => {
        setView(loaded);
        const first = loaded.projects[0];
        if (first) setSelectedId((current) => current ?? first.projectId);
      })
      .catch((reason: unknown) => setError(messageFrom(reason)));
  }, [bridge]);

  async function chooseScheme(scheme: AppearanceScheme): Promise<void> {
    if (busy || view?.scheme === scheme) return;
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

  const selected = view?.projects.find((project) => project.projectId === selectedId) ?? null;

  return (
    <div className="rennet-glass settings" data-scheme={schemeAttr(view?.scheme)}>
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
                      disabled={busy}
                    >
                      {option.label}
                    </button>
                  ))}
                </fieldset>
                <Provenance provenance={view.schemeProvenance} />
              </div>
            </div>
            <p className="settings-note">
              A personal preference, stored on this machine only. It never leaves it and never
              touches a repository.
            </p>
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
              selectedId={selectedId}
              onSelect={setSelectedId}
              onVisibilityResolved={(projectId, visibility) =>
                setView((current) =>
                  current
                    ? {
                        ...current,
                        projects: current.projects.map((project) =>
                          project.projectId === projectId
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
            />
          )
        ) : null}
      </div>
    </div>
  );
}

/** The repo scope: a project picker + the selected project's ladder + guidance. */
function RepoPanel({
  bridge,
  projects,
  selected,
  selectedId,
  onSelect,
  onVisibilityResolved,
}: {
  bridge: RennetBridge;
  projects: readonly SettingsProject[];
  selected: SettingsProject | null;
  selectedId: string | null;
  onSelect(id: string): void;
  onVisibilityResolved(projectId: string, visibility: ProjectVisibility): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [guidance, setGuidance] = useState<SettingsGuidance | null>(null);

  useEffect(() => {
    if (!selectedId) return;
    setGuidance(null);
    setNote(undefined);
    bridge
      .invoke("settings.guidance", { projectId: selectedId })
      .then(setGuidance)
      .catch(() => setGuidance({ rules: [], reason: "unreadable", dropped: 0 }));
  }, [bridge, selectedId]);

  async function chooseVisibility(visibility: ProjectVisibility): Promise<void> {
    if (!selected || busy || selected.visibility === visibility) return;
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const result = await bridge.invoke("settings.setRepoVisibility", {
        commandId: crypto.randomUUID(),
        projectId: selected.projectId,
        visibility,
      });
      onVisibilityResolved(selected.projectId, result.visibility);
      setNote(
        result.changed
          ? `Updated ${result.gitignorePath}`
          : "Already excluded — no .gitignore change was needed.",
      );
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-panel" aria-label="Repository settings">
      <div className="settings-picker" role="tablist" aria-label="Project">
        {projects.map((project) => (
          <button
            key={project.projectId}
            type="button"
            role="tab"
            aria-selected={project.projectId === selectedId}
            className={`settings-pick${project.projectId === selectedId ? " on" : ""}`}
            onClick={() => onSelect(project.projectId)}
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
                    disabled={busy}
                  >
                    {option.label}
                  </button>
                ))}
              </fieldset>
              <Provenance provenance={selected.visibilityProvenance} />
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
              <span className="settings-prov">read-through</span>
            </div>
          </div>

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

/** `data-scheme` only carries an EXPLICIT choice; `system` leaves it unset. */
function schemeAttr(scheme: AppearanceScheme | undefined): "dark" | "light" | undefined {
  return scheme === "dark" || scheme === "light" ? scheme : undefined;
}
