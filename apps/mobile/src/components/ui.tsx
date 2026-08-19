// Shared presentational primitives (issue #383 M1), styled to the kit transpose (theme/tokens).
// Plain RN components — no component-library dependency in M1 (the design decision): the kit
// look is plain styles over the theme. Every colour comes from `useTheme()` so light/dark both
// read correctly.

import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Switch, Text, View, type ViewStyle } from "react-native";
import { radii, space, type } from "../theme/tokens";
import { useTheme } from "../theme/use-theme";

/** A screen container with the canvas background and comfortable padding. */
export function Screen({ children }: { children: ReactNode }): ReactNode {
  const t = useTheme();
  return <View style={[styles.screen, { backgroundColor: t.canvas }]}>{children}</View>;
}

/** A section eyebrow label (e.g. "TODAY", "CANVASES", "THIS PHONE"). */
export function SectionLabel({ children }: { children: ReactNode }): ReactNode {
  const t = useTheme();
  return <Text style={[styles.sectionLabel, { color: t.faint }]}>{children}</Text>;
}

/** A card surface — the review-row / connection-row container. `backlit` gives the blue focus glow. */
export function Card({
  children,
  onPress,
  backlit,
}: {
  children: ReactNode;
  onPress?: () => void;
  backlit?: boolean;
}): ReactNode {
  const t = useTheme();
  const style: ViewStyle = {
    backgroundColor: backlit ? t.blueBg : t.card,
    borderColor: backlit ? t.blueLine : t.line2,
  };
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={[styles.card, style]}>
        {children}
      </Pressable>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

export type ChipTone = "neutral" | "blue" | "amber" | "green";

/** A status chip (running / needs-you / fresh / stale …), toned per the material law. */
export function Chip({ label, tone = "neutral" }: { label: string; tone?: ChipTone }): ReactNode {
  const t = useTheme();
  const map = {
    neutral: { fg: t.muted, bg: t.card, bd: t.line2 },
    blue: { fg: t.blueInk, bg: t.blueBg, bd: t.blueLine },
    amber: { fg: t.amber, bg: t.amberBg, bd: t.amberLine },
    green: { fg: t.green, bg: t.greenBg, bd: t.greenLine },
  }[tone];
  return (
    <Text style={[styles.chip, { color: map.fg, backgroundColor: map.bg, borderColor: map.bd }]}>
      {label}
    </Text>
  );
}

/** A digest stat tile (17 findings / 6 resolved / …). `tone` colours the number. */
export function StatTile({
  value,
  label,
  tone = "neutral",
}: {
  value: number | string;
  label: string;
  tone?: ChipTone;
}): ReactNode {
  const t = useTheme();
  const color =
    tone === "green" ? t.green : tone === "amber" ? t.amber : tone === "blue" ? t.blueInk : t.ink;
  return (
    <View style={[styles.tile, { backgroundColor: t.card, borderColor: t.line2 }]}>
      <Text style={[styles.tileValue, { color }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: t.muted }]}>{label}</Text>
    </View>
  );
}

/** Primary (ink) action button. */
export function PrimaryButton({
  label,
  onPress,
}: {
  label: string;
  onPress?: () => void;
}): ReactNode {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} style={[styles.btn, { backgroundColor: t.ink }]}>
      <Text style={[styles.btnLabel, { color: t.canvas }]}>{label}</Text>
    </Pressable>
  );
}

/** Secondary (outline) action button. */
export function OutlineButton({
  label,
  onPress,
}: {
  label: string;
  onPress?: () => void;
}): ReactNode {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} style={[styles.btn, styles.btnOutline, { borderColor: t.line2 }]}>
      <Text style={[styles.btnLabel, { color: t.text }]}>{label}</Text>
    </Pressable>
  );
}

/** A tappable answer chip (the ask card's decision chips). `selected` fills it ink. */
export function AnswerChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
}): ReactNode {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.answerChip,
        {
          backgroundColor: selected ? t.ink : t.card,
          borderColor: selected ? t.ink : t.line2,
        },
      ]}
    >
      <Text
        style={{ color: selected ? t.canvas : t.text, fontSize: type.control, fontWeight: "500" }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A destructive/stop control (the live turn's visible Stop). Disabled ⇒ visibly dimmed and
 *  inert (a pre-M2 daemon cannot interrupt; the control tells the truth rather than no-opping). */
export function StopButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
}): ReactNode {
  const t = useTheme();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={[
        styles.stopBtn,
        { backgroundColor: t.amberBg, borderColor: t.amberLine },
        disabled ? { opacity: 0.4 } : null,
      ]}
    >
      <Text style={{ color: t.amber, fontSize: type.control, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/** A monospaced diff hunk block. Additions read green, deletions amber, per the material law. */
export function HunkBlock({ diff }: { diff: string }): ReactNode {
  const t = useTheme();
  return (
    <View style={[styles.hunk, { backgroundColor: t.card, borderColor: t.line2 }]}>
      {diff.split("\n").map((line, i) => {
        const color = line.startsWith("+") ? t.green : line.startsWith("-") ? t.amber : t.text;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are a static, never-reordered list; the index is the stable identity.
          <Text key={`${i}-${line}`} style={[styles.hunkLine, { color }]}>
            {line}
          </Text>
        );
      })}
    </View>
  );
}

/** A labelled toggle row for the notification settings screen. */
export function SwitchRow({
  title,
  subtitle,
  value,
  onValueChange,
  disabled,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onValueChange?: (v: boolean) => void;
  disabled?: boolean;
}): ReactNode {
  const t = useTheme();
  return (
    <View
      style={[styles.card, styles.switchRow, { backgroundColor: t.card, borderColor: t.line2 }]}
    >
      <View style={styles.switchText}>
        <Text style={[styles.rowTitle, { color: t.text }]}>{title}</Text>
        <Text style={[styles.rowSub, { color: t.muted }]}>{subtitle}</Text>
      </View>
      <Switch value={value} onValueChange={onValueChange} disabled={disabled} />
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: space.lg, paddingTop: space.lg },
  sectionLabel: {
    fontSize: type.pill,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginTop: space.lg,
    marginBottom: space.sm,
  },
  card: {
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: space.lg,
    marginBottom: space.sm,
  },
  chip: {
    fontSize: type.chip,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: "hidden",
    alignSelf: "flex-start",
  },
  tile: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: space.md,
    alignItems: "center",
    marginHorizontal: 3,
  },
  tileValue: { fontSize: type.title, fontWeight: type.weightSemibold },
  tileLabel: { fontSize: type.chip, marginTop: 2 },
  btn: {
    borderRadius: radii.md,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.sm,
  },
  btnOutline: { borderWidth: 1, backgroundColor: "transparent" },
  btnLabel: { fontSize: type.body, fontWeight: type.weightMedium },
  answerChip: {
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: "flex-start",
  },
  stopBtn: {
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignSelf: "flex-start",
  },
  hunk: { borderWidth: 1, borderRadius: radii.md, padding: space.md, marginVertical: space.sm },
  // Genuine code/diff surface: the ONE place monospace is sanctioned by the kit (--code).
  hunkLine: {
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: type.chip,
    lineHeight: 18,
  },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchText: { flex: 1, paddingRight: space.md },
  rowTitle: { fontSize: type.body, fontWeight: type.weightSemibold },
  rowSub: { fontSize: type.control, marginTop: 2 },
});
