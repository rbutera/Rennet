import { cn, Toggle, ToggleGroup } from "@rennet/ui";
import type { ReactNode } from "react";
import { BackingFile } from "./backing-file";

// ─────────────────────────────────────────────────────────────────────────────
// The settings page presentational atoms (C10 §1.3), ported from the spike's
// `settings-view.tsx` (Section / Row / Segmented) — layout faithful, values
// rewritten onto Rennet's design tokens (ink / line / raised, never the spike's
// foreground / border). Every settings page composes these, so the shared spacing,
// the boxed-section rhythm, and the mono backing-file caption live in one file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A titled settings section. `caption` is the section's backing file (rendered as
 * the shared {@link BackingFile} mono caption, claim 578). A section with NO backing
 * file yet (a session-only client pref, not persisted to any file) OMITS `caption`
 * and sets `sessionOnly`, so the header states that honestly instead of naming a file
 * the value never reaches. `bare` drops the boxed surface so children that bring their
 * own card (the environment cards) sit flush.
 */
export function Section({
  title,
  titleExtra,
  caption,
  sessionOnly,
  bare,
  children,
}: {
  readonly title: string;
  readonly titleExtra?: ReactNode;
  readonly caption?: string;
  /** No file backs this section yet (session-only); shown in place of a backing file. */
  readonly sessionOnly?: boolean;
  readonly bare?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section data-slot="settings-section" className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium text-ink">
          {title}
          {titleExtra}
        </span>
        {caption ? (
          <BackingFile file={caption} />
        ) : sessionOnly ? (
          <span data-slot="session-only" className="text-2xs text-ink-faint italic">
            session only
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          "flex flex-col",
          bare ? "gap-3 pt-1" : "divide-y divide-line rounded-md border border-line px-3",
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** One labelled control row. `stacked` puts the control under the label + hint. */
export function Row({
  label,
  hint,
  stacked,
  children,
}: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly stacked?: boolean;
  readonly children: ReactNode;
}) {
  if (stacked) {
    return (
      <div className="flex flex-col gap-1.5 py-2.5">
        <div className="flex flex-col">
          <span className="text-xs font-medium text-ink">{label}</span>
          {hint ? <span className="text-xs text-ink-soft">{hint}</span> : null}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className="flex min-h-11 items-center gap-3 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-xs font-medium text-ink">{label}</span>
        {hint ? <span className="text-xs text-ink-soft">{hint}</span> : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * A compact segmented control — one option lit at a time. Built on the kit's
 * single-select `ToggleGroup`/`Toggle` (autopsy S6 forbids a hand-rolled
 * aria-pressed / role=radiogroup group). Base UI models selection as an array;
 * clicking the lit option would empty it, which a segmented control must ignore.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled,
}: {
  readonly options: readonly { readonly id: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (id: T) => void;
  readonly ariaLabel: string;
  /** Lock the whole control (a still-unserved setting discloses its gap; default off). */
  readonly disabled?: boolean;
}) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      value={[value]}
      disabled={disabled}
      onValueChange={(next: string[]) => {
        const picked = next[0] as T | undefined;
        if (picked && picked !== value) onChange(picked);
      }}
    >
      {options.map((option) => (
        <Toggle key={option.id} value={option.id} size="sm">
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/**
 * A wrapping row of pill options — one lit at a time, live-apply on click. The spike's
 * Appearance page hand-rolled this as a `role="radiogroup"` of `role="radio"` buttons;
 * autopsy S6 forbids that (the same rule that put {@link Segmented} on the kit), so this
 * ports the visual onto the kit's single-select `ToggleGroup` too — the segmented
 * container's joined chrome overridden to a border-less, wrapping pill layout, each pill
 * the kit's `outline` toggle restyled onto Rennet tokens (raised fill + accent-line
 * border when lit, never the kit's default gold accent fill).
 */
export function PillChoice<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  readonly options: readonly { readonly id: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (id: T) => void;
  readonly ariaLabel: string;
}) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      value={[value]}
      onValueChange={(next: string[]) => {
        const picked = next[0] as T | undefined;
        if (picked && picked !== value) onChange(picked);
      }}
      className="flex w-auto flex-wrap gap-1.5 bg-transparent p-0"
    >
      {options.map((option) => (
        <Toggle
          key={option.id}
          value={option.id}
          size="sm"
          variant="outline"
          className="rounded-md border-line px-2.5 text-xs text-ink-soft hover:bg-raised/50 hover:text-ink data-pressed:border-accent-line data-pressed:bg-raised data-pressed:text-ink"
        >
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
