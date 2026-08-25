"use client"

import {
  BookOpen,
  Box,
  Cpu,
  CreditCard,
  Database,
  FlaskConical,
  Globe,
  Layers,
  Package,
  Rocket,
  Shield,
  Terminal,
} from "lucide-react"

/** Per-project glyphs; `layers` is the default every project starts with. */
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
} as const

export type ProjectIconName = keyof typeof PROJECT_ICONS

export function ProjectIcon({
  icon,
  className,
}: {
  icon?: ProjectIconName
  className?: string
}) {
  const Glyph = PROJECT_ICONS[icon ?? "layers"]
  return <Glyph className={className} aria-hidden="true" />
}
