import { projectLogoMimeSchema } from "@rennet/protocol";
import { cn, Toggle, ToggleGroup } from "@rennet/ui";
import { RotateCcw, Upload } from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, useState } from "react";
import { Icon } from "../../components/icon";
import type { SidebarProject } from "../../shell/sidebar-data";
import {
  DEFAULT_PROJECT_ICON,
  PROJECT_ICON_NAMES,
  type ProjectIconName,
} from "../assets/project-icon";
import { logoMark, ProjectMark } from "../assets/project-mark";
import { Row, Section } from "../atoms";
import { projectMarkFor, useSettingsProjection } from "../data";
import { UnbackedNote } from "./unbacked-note";

// ─────────────────────────────────────────────────────────────────────────────
// The Projects → Identity section (C10 §8.2, claims 649–652). The display name
// (the `org/repo` default as placeholder, a Reset when renamed, the default restored
// on an emptied commit) and the project MARK — the glyph grid, plus the repo's own
// logo and an uploaded image (#900).
//
// The two rows persist to DIFFERENT stores, which is why the caption names both: the
// NAME writes through `project.rename` into the projects store (`projects.json`), while
// the mark writes the repo rung — `glyph`/`mark` through `settings.setProjectValue`, and
// an upload's bytes through `project.uploadLogo` into the host's project directory.
//
// Exactly one of the glyph, the repo logo and the upload reads as selected, and the one
// that reads selected is the RESOLVED mark — what the sidebar is actually showing. A
// logo whose bytes are gone therefore lights the glyph here too, rather than leaving the
// grid dark beside a sidebar row wearing a symbol.
//
// The grids are the kit's single-select `ToggleGroup` (autopsy S6 forbids the spike's
// hand-rolled `role="radiogroup"`), restyled to square icon cells.
// ─────────────────────────────────────────────────────────────────────────────

/** The image formats a logo may be — the wire's own list, so the picker, the refusal
 *  sentence and the command can never name three different sets. */
const LOGO_MIMES = projectLogoMimeSchema.options;

/** Escape clears the field WITHOUT closing the settings takeover (the root handler). */
function stopEscape(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "Escape") {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).blur();
  }
}

export function IdentitySection({ project }: { readonly project: SidebarProject }) {
  const projection = useSettingsProjection();
  // No served write store yet ⇒ show the controls disabled + disclose the gap, never
  // an enabled field bound to the projection's no-op setter (which would eat input).
  // Per PROJECT: the capability belongs to this project's served row, not to the
  // surface — a project the daemon has no row for stays disabled even when a sibling
  // project's editors are live.
  const backed = projection.prefsBackedByProject[project.id] ?? projection.projectEditsPersist;
  // The name writes through `project.rename` (C18) even where the glyph does not, so the
  // field is enabled on its own truth rather than on the unserved editors' flag.
  const nameBacked = projection.nameEditsPersist;
  const name = projection.nameByProject[project.id] ?? project.name;
  const glyph = projection.glyphByProject[project.id] ?? DEFAULT_PROJECT_ICON;
  const mark = projectMarkFor(projection, project.id);
  const logos = projection.logosByProject[project.id];
  const renamed = nameBacked && name !== project.fallbackName;
  // The field holds a LOCAL draft and commits on blur/Enter — the same shape the sidebar's
  // session rename uses. `setProjectName` is a served write (`project.rename` persists to
  // the projects store), so a per-keystroke binding would write once per character and, on
  // a controlled input, drop characters whenever the round trip lagged the typing.
  const [draft, setDraft] = useState<string | null>(null);
  /** The one-line answer to the last action taken here — a refused file, or what a
   *  re-detection found. Never a running commentary: the newest answer replaces the old. */
  const [note, setNote] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);

  function commitName() {
    if (draft === null) return;
    // An emptied name never persists — it falls back to the org/repo default (R67).
    projection.setProjectName(project.id, draft.trim() || project.fallbackName);
    setDraft(null);
  }

  function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clear the input so choosing the SAME file again still fires a change — a reviewer
    // who re-exports an image and picks it once more expects the new bytes.
    event.target.value = "";
    if (!file) return;
    if (!(LOGO_MIMES as readonly string[]).includes(file.type)) {
      setNote("Choose an SVG, PNG, JPEG, or WebP image.");
      return;
    }
    setNote(null);
    projection.uploadProjectLogo(project.id, file);
  }

  async function detectAgain() {
    setDetecting(true);
    setNote(null);
    const outcome = await projection.detectProjectLogo(project.id);
    setDetecting(false);
    // The host's own answer, said plainly. A detection that found nothing leaves whatever
    // was found before in place, so this says what happened, not what changed.
    setNote(
      outcome.found && outcome.source ? `Found ${outcome.source}` : "No logo found in the repo",
    );
  }

  return (
    <Section title="Identity" caption="~/.rennet/projects.json · projects/<repo>/config.json">
      <Row label="Name" hint={`defaults to ${project.fallbackName}`}>
        {renamed ? (
          <button
            type="button"
            onClick={() => {
              setDraft(null);
              projection.setProjectName(project.id, project.fallbackName);
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-soft transition-colors hover:bg-raised hover:text-ink"
          >
            <Icon icon={RotateCcw} className="size-3" />
            Reset
          </button>
        ) : null}
        <input
          value={draft ?? name}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitName();
            stopEscape(event);
          }}
          disabled={!nameBacked}
          aria-label="Project name"
          placeholder={project.fallbackName}
          className={cn(
            "w-56 rounded-md border border-line bg-surface px-2 py-1.5 text-13 text-ink placeholder:text-ink-faint focus-visible:border-accent-line focus-visible:outline-none",
            !nameBacked && "cursor-not-allowed opacity-60",
          )}
        />
      </Row>
      <Row label="Glyph" hint="shown next to the project in the sidebar" stacked>
        <ToggleGroup
          aria-label="Project glyph"
          // Lit only while the glyph IS the mark: a project wearing a logo shows no glyph
          // in the sidebar, so nothing here may read as the one it is wearing.
          value={mark.kind === "glyph" ? [glyph] : []}
          disabled={!backed}
          onValueChange={(next: string[]) => {
            const picked = next[0] as ProjectIconName | undefined;
            if (picked) projection.setProjectGlyph(project.id, picked);
          }}
          className="flex w-auto flex-wrap gap-1 border-transparent bg-transparent p-0"
        >
          {PROJECT_ICON_NAMES.map((iconName) => (
            <Toggle
              key={iconName}
              value={iconName}
              aria-label={iconName}
              title={iconName}
              variant="outline"
              className={cn(
                "size-8 rounded-md border-transparent p-0 text-ink-soft",
                "hover:bg-raised/60 hover:text-ink",
                "data-pressed:border-accent-line data-pressed:bg-raised data-pressed:text-ink",
              )}
            >
              <ProjectMark mark={{ kind: "glyph", icon: iconName }} className="size-4" />
            </Toggle>
          ))}
        </ToggleGroup>
      </Row>
      <Row label="Logo" hint="an image from the repo, or one you choose" stacked>
        <div className="flex flex-wrap items-center gap-2">
          {logos?.detected || logos?.upload ? (
            <ToggleGroup
              aria-label="Project logo"
              value={mark.kind === "logo" ? [mark.logo] : []}
              disabled={!backed}
              onValueChange={(next: string[]) => {
                const picked = next[0];
                if (picked === "detected" || picked === "upload") {
                  projection.setProjectMark(project.id, picked);
                }
              }}
              className="flex w-auto flex-wrap gap-1 border-transparent bg-transparent p-0"
            >
              {logos.detected ? (
                <Toggle
                  value="detected"
                  aria-label="Repo logo"
                  title={logos.detected.source}
                  variant="outline"
                  className="size-8 rounded-md border-transparent p-0 hover:bg-raised/60 data-pressed:border-accent-line data-pressed:bg-raised"
                >
                  <ProjectMark mark={logoMark(logos.detected)} className="size-4" />
                </Toggle>
              ) : null}
              {logos.upload ? (
                <Toggle
                  value="upload"
                  aria-label="Uploaded logo"
                  title={logos.upload.source}
                  variant="outline"
                  className="size-8 rounded-md border-transparent p-0 hover:bg-raised/60 data-pressed:border-accent-line data-pressed:bg-raised"
                >
                  <ProjectMark mark={logoMark(logos.upload)} className="size-4" />
                </Toggle>
              ) : null}
            </ToggleGroup>
          ) : null}
          <label
            className={cn(
              "flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-soft transition-colors",
              backed ? "cursor-pointer hover:bg-raised hover:text-ink" : "opacity-60",
            )}
          >
            <Icon icon={Upload} className="size-3" />
            {logos?.upload ? "Replace image" : "Upload an image"}
            {/* The wrapping label IS the control's name, so the visible words and the
                accessible name can never drift apart. */}
            <input
              type="file"
              accept={LOGO_MIMES.join(",")}
              disabled={!backed}
              onChange={pickFile}
              className="sr-only"
            />
          </label>
          <button
            type="button"
            onClick={() => void detectAgain()}
            disabled={!backed || detecting}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:bg-raised hover:text-ink disabled:opacity-60"
          >
            {detecting ? "Looking…" : "Detect again"}
          </button>
        </div>
        {logos?.detected ? (
          <span className="text-xs text-ink-soft">Repo logo · {logos.detected.source}</span>
        ) : null}
        {logos?.upload ? (
          <span className="text-xs text-ink-soft">Uploaded · {logos.upload.source}</span>
        ) : null}
        {note ? (
          <span data-slot="logo-note" className="text-xs text-ink-soft">
            {note}
          </span>
        ) : null}
      </Row>
      {backed ? null : (
        <div className="py-2.5">
          <UnbackedNote>
            Marks aren&rsquo;t served yet — this lands with the settings engine.
          </UnbackedNote>
        </div>
      )}
    </Section>
  );
}
