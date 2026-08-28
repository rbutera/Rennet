import { Keyboard, Layers, type LucideIcon, Monitor, Palette } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// The four settings pages (C10 §1.1–1.2, claim 577). Settings is a ROUTE, not a
// `useState` page switch (autopsy S2): the active page is derived from the
// `/settings/:page` param through `parseSettingsPage`, and each page is its own
// module reached by that param. This file is the single registry the left nav
// renders from and the screen routes by.
//
// Slug reconciliation (recorded): the LANDED C3 sidebar already navigates to
// `settingsPath("keybindings")` and the packet/#476 name the page "Keyboard
// Shortcuts" with a `/settings/shortcuts` deep-link; the spike used `machine` for
// Environments. `keybindings` and `environments` are the canonical slugs (the
// shipped C3 links and the packet verification target, respectively), and the
// aliases keep every existing entry point resolving. An unknown slug falls back to
// `appearance` — the page the sidebar's Settings control opens by default.
// ─────────────────────────────────────────────────────────────────────────────

export type SettingsPageId = "environments" | "appearance" | "keybindings" | "projects";

export interface SettingsPageMeta {
  readonly id: SettingsPageId;
  /** The `:page` slug this page mounts at (what the left nav navigates to). */
  readonly slug: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

/** The four pages, in nav order (Environments, Appearance, Keyboard Shortcuts, Projects). */
export const SETTINGS_PAGES: readonly SettingsPageMeta[] = [
  { id: "environments", slug: "environments", label: "Environments", icon: Monitor },
  { id: "appearance", slug: "appearance", label: "Appearance", icon: Palette },
  { id: "keybindings", slug: "keybindings", label: "Keyboard Shortcuts", icon: Keyboard },
  { id: "projects", slug: "projects", label: "Projects", icon: Layers },
];

/** The pages keyed by id — a total lookup for the screen (no `find` undefined). */
export const SETTINGS_PAGE_BY_ID: Record<SettingsPageId, SettingsPageMeta> = Object.fromEntries(
  SETTINGS_PAGES.map((p) => [p.id, p]),
) as Record<SettingsPageId, SettingsPageMeta>;

/** The default page an absent or unknown slug resolves to. */
export const DEFAULT_SETTINGS_PAGE: SettingsPageId = "appearance";

/** Slugs that map onto a canonical page id (canonical + accepted aliases). */
const SLUG_TO_ID: Record<string, SettingsPageId> = {
  environments: "environments",
  machine: "environments", // spike alias
  appearance: "appearance",
  keybindings: "keybindings",
  shortcuts: "keybindings", // packet/#476 deep-link alias
  projects: "projects",
};

/**
 * Resolve the `:page` route param to a page id. The param DRIVES the page (task
 * 12.2's positive control): an unknown/absent slug falls back to the default, it
 * is never read from a shadowed `useState`.
 */
export function parseSettingsPage(raw: string | null | undefined): SettingsPageId {
  if (raw == null) return DEFAULT_SETTINGS_PAGE;
  return SLUG_TO_ID[raw.toLowerCase()] ?? DEFAULT_SETTINGS_PAGE;
}
