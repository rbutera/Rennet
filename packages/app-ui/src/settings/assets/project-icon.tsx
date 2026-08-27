import { cn } from "@rennet/ui";
import {
  BookOpen,
  Box,
  Cpu,
  CreditCard,
  Database,
  FlaskConical,
  Globe,
  Layers,
  type LucideIcon,
  Package,
  Rocket,
  Shield,
  Terminal,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Project glyphs (C10 §8.2, claims 649–652), ported from the spike's
// `project-icon.tsx` as a real app-ui lib. The Projects page's glyph radio grid
// picks one, and the choice applies live to the sidebar's project row — one glyph
// vocabulary, shared by both. `layers` is the default every project starts with.
// ─────────────────────────────────────────────────────────────────────────────

export const PROJECT_ICONS = {
  layers: Layers,
  box: Box,
  package: Package,
  rocket: Rocket,
  globe: Globe,
  terminal: Terminal,
  database: Database,
  "credit-card": CreditCard,
  book: BookOpen,
  cpu: Cpu,
  shield: Shield,
  flask: FlaskConical,
} satisfies Record<string, LucideIcon>;

export type ProjectIconName = keyof typeof PROJECT_ICONS;

/** Every glyph id in grid order — the radio grid renders from this. */
export const PROJECT_ICON_NAMES = Object.keys(PROJECT_ICONS) as ProjectIconName[];

/** The default glyph an untouched project carries (and an emptied choice falls back to). */
export const DEFAULT_PROJECT_ICON: ProjectIconName = "layers";

export function ProjectIcon({
  icon,
  className,
}: {
  readonly icon?: ProjectIconName;
  readonly className?: string;
}) {
  const Glyph = PROJECT_ICONS[icon ?? DEFAULT_PROJECT_ICON];
  return <Glyph className={cn("size-3.5", className)} aria-hidden="true" />;
}
