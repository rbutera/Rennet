// Rennet's line-icon identity is a ~1.6px currentColor stroke (root DESIGN.md);
// lucide-react ships its icons at 2px, so this thin wrapper restores the product
// line weight across every app-ui icon in one place. Icons are decorative (they
// sit beside a text label), so they default to aria-hidden the way the retired
// bespoke set did. Size on the Tailwind ramp via className (size-4, size-3.5 …),
// never the raw numeric size prop.

import type { LucideIcon, LucideProps } from "lucide-react";

export interface IconProps extends LucideProps {
  icon: LucideIcon;
}

export function Icon({
  icon: Glyph,
  strokeWidth = 1.6,
  "aria-hidden": ariaHidden = true,
  ...rest
}: IconProps) {
  return <Glyph strokeWidth={strokeWidth} aria-hidden={ariaHidden} {...rest} />;
}
