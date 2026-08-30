import { cn, Switch } from "@rennet/ui";
import { Fragment, type ReactNode } from "react";
import { Row } from "../atoms";
import type { DetectedTool, ToolStatus } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// The shared detection row (C10 §4.2 / §5.1). Source-control tooling and coding
// harnesses read in ONE row shape: the official mark, the tool label, the tool's
// own version line (shown only when detected — never a guess), a status chip, an
// honest one-line helper naming the exact fix (backticked commands render as code),
// and an enable toggle only when the projected behavior has a real consumer. Built on
// the kit `Switch` + the shared `Row` atom (autopsy S6 forbids a hand-rolled toggle).
// ─────────────────────────────────────────────────────────────────────────────

const STATUS: Record<ToolStatus, { readonly label: string; readonly chip: string }> = {
  available: { label: "Available", chip: "bg-green-soft text-green" },
  "not-authenticated": { label: "Not Authenticated", chip: "bg-accent-soft text-accent-ink" },
  unreachable: { label: "Unreachable", chip: "bg-accent-soft text-accent-ink" },
  "not-installed": { label: "Not Installed", chip: "bg-raised text-ink-soft" },
};

/** The four honest states a detected tool can be in, as a chip. */
export function StatusChip({ status }: { readonly status: ToolStatus }) {
  const { label, chip } = STATUS[status];
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-2xs font-medium tracking-wide", chip)}>
      {label}
    </span>
  );
}

/** Settings copy renders `backticked` commands as inline code. Keyed by string
 *  offset (not array index) so the segments are stable and lint-clean. */
export function CommandCopy({ text }: { readonly text: string }) {
  const nodes: ReactNode[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    if (match.index > last) {
      nodes.push(<Fragment key={`t${last}`}>{text.slice(last, match.index)}</Fragment>);
    }
    nodes.push(
      <code key={`c${match.index}`} className="rounded bg-raised px-1 font-mono">
        {match[1]}
      </code>,
    );
    last = match.index + match[0].length;
    match = re.exec(text);
  }
  if (last < text.length) nodes.push(<Fragment key={`t${last}`}>{text.slice(last)}</Fragment>);
  return <>{nodes}</>;
}

/** One detection row (a forge CLI or a coding harness). `mark` is the tool's glyph. */
export function DetectionRow({
  tool,
  mark,
  toggle,
}: {
  readonly tool: DetectedTool;
  readonly mark: ReactNode;
  readonly toggle: {
    readonly label: string;
    readonly onChange: (enabled: boolean) => void;
  } | null;
}) {
  return (
    <Row
      label={
        <span className="flex items-center gap-2">
          {mark}
          {tool.label}
          {tool.version ? (
            <span className="font-mono text-2xs font-normal text-ink-faint">{tool.version}</span>
          ) : null}
          <StatusChip status={tool.status} />
        </span>
      }
      hint={<CommandCopy text={tool.detail} />}
    >
      {toggle ? (
        <Switch
          checked={tool.enabled}
          onCheckedChange={toggle.onChange}
          aria-label={toggle.label}
          size="sm"
        />
      ) : null}
    </Row>
  );
}

/** A titled sub-section inside a host card (Source Control / Agents), with a top rule. */
export function CardSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col border-t border-line pt-1">
      <span className="pt-1 text-xs font-medium text-ink">{title}</span>
      {children}
    </div>
  );
}
