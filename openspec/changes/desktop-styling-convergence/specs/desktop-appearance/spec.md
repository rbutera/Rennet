# Desktop appearance

## Purpose

Defines how the desktop app applies appearance choices — theme packs, code themes, project glyphs — and the visual baseline it must match: the board prototype's control ramp, base-layer rules, and dark ground palette.

## ADDED Requirements

### Requirement: Theme packs and code themes apply on every OS color scheme

A selected theme pack SHALL restyle the app, and a selected code theme SHALL restyle syntax highlighting, regardless of the operating system's light/dark preference and regardless of the app's scheme setting. The OS-preference dark fallback SHALL apply only to surfaces that never stamp a scheme, and SHALL be structurally unable to outrank a stamped theme pack or code theme.

#### Scenario: Theme pack on a dark-mode OS

- **WHEN** the OS prefers dark, the app scheme is Dark or System, and the user picks the Dracula theme pack
- **THEN** the app's surfaces render Dracula's palette, not the default dark palette

#### Scenario: Code theme on a dark-mode OS

- **WHEN** the OS prefers dark and the user picks a code theme
- **THEN** code blocks, diff views, and review code surfaces render that theme's syntax colors immediately, with no re-highlight

#### Scenario: Unstamped surface still follows the OS

- **WHEN** a page renders without any scheme stamped on its root (e.g. marketing, pre-hydration docs)
- **THEN** it follows the OS dark preference as before

### Requirement: Visual system matches the board prototype

The desktop SHALL render controls, borders, headings, overlay animations, and dark ground colors identical to the board prototype: prototype-sized buttons and inputs (default control height 32px, medium weight), hairline `border-border` on bare borders, display-font headings, animated overlay entrances/exits, the prototype's desaturated dark ground palette, and the copper warn register.

#### Scenario: Buttons and inputs

- **WHEN** a default-size button or input renders
- **THEN** its height, padding, and font weight match the prototype's control ramp (h-8, font-medium), one step smaller than the previously shipped ramp

#### Scenario: Bare borders

- **WHEN** a component uses `border` without an explicit color
- **THEN** it renders the hairline border color, not full-ink currentColor

#### Scenario: Overlay animation

- **WHEN** a popover, dialog, menu, or coachmark opens or closes
- **THEN** it animates (fade/zoom) rather than snapping

#### Scenario: File picker

- **WHEN** the directory browser renders
- **THEN** its rows, breadcrumb, list sizing, and error styling match the prototype's directory browser (13px rows, viewport-relative list height with a minimum, no card fill)

### Requirement: Sidebar renders the project's chosen glyph

The left sidebar's project rows and the new-chat project picker SHALL render each project's persisted glyph, falling back to the default glyph when none is set, and SHALL update live when the glyph changes in project settings.

#### Scenario: Glyph set in settings

- **WHEN** the user picks a glyph for a project in project settings
- **THEN** the sidebar row and new-chat picker for that project show the chosen glyph without a restart

#### Scenario: No glyph chosen

- **WHEN** a project has no persisted glyph
- **THEN** the sidebar shows the default project glyph

### Requirement: Project settings show no provenance badges

The project settings Repository and Issue Tracker sections SHALL NOT render provenance badges (layer summaries such as "REPO"/"BUILTIN"/"DETECTED" or contribution chips such as "builtin: local"). The functional controls, reset affordances, and detected-value labels remain.

#### Scenario: Repository section

- **WHEN** the Repository settings section renders
- **THEN** no provenance badge appears beside Review Context, Promotion, or Runs on, while the segmented controls, Reset, and status text remain

#### Scenario: Issue tracker section

- **WHEN** the Issue Tracker settings section renders, for any tracker choice
- **THEN** no provenance badge appears beside the tracker picker or its text fields

### Requirement: macOS sidebar wordmark clears the traffic lights

On macOS the sidebar wordmark SHALL sit clear of the traffic lights with an 81px left reserve; other platforms keep standard padding, and interactive controls continue to clear the OS light zone.

#### Scenario: macOS sidebar header

- **WHEN** the sidebar header renders on macOS
- **THEN** the wordmark starts 81px from the left edge and the sidebar toggle remains right-pinned
