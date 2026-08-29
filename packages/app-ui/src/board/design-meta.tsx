import type { SourceRef, SpecDelta } from "@rennet/protocol";
import { cn } from "@rennet/ui";
import { FileText } from "lucide-react";
import { Icon } from "../components/icon";
import { useMutation } from "../data";
import { useBoardReviewId } from "./kinds/element-context";

const SPEC_DELTA_TONE: Readonly<Record<SpecDelta, string>> = {
  added: "border-green-line bg-green-soft text-green",
  modified: "border-accent-line bg-accent-soft text-accent",
  removed: "border-danger bg-danger-soft text-danger",
  renamed: "border-line bg-raised text-ink-soft",
};

export function SpecDeltaBadge({ delta }: { readonly delta: SpecDelta }) {
  return (
    <span
      data-kind="spec-delta"
      data-spec-delta={delta}
      className={cn(
        "shrink-0 rounded-chip border px-1.5 py-0.5 font-medium text-2xs",
        SPEC_DELTA_TONE[delta],
      )}
    >
      {delta}
    </span>
  );
}

type SourceChipKind = "artifact" | "source" | "related-file";

const SOURCE_CHIP =
  "inline-flex max-w-full items-center gap-1 rounded-chip border border-line bg-surface px-1.5 py-0.5 font-mono text-2xs text-ink-soft";

function SourceChip({
  source,
  kind,
  targetId,
}: {
  readonly source: SourceRef;
  readonly kind: SourceChipKind;
  readonly targetId?: string;
}) {
  const reviewId = useBoardReviewId();
  const { mutate: openInEditor, pending } = useMutation("review.openInEditor");
  const label =
    source.label ?? `${source.path}${source.line === undefined ? "" : `:${source.line}`}`;
  const common = {
    "data-kind": `${kind}-chip`,
    "data-source-path": source.path,
    ...(source.line === undefined ? {} : { "data-source-line": source.line }),
  };
  const content = (
    <>
      <Icon icon={FileText} className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </>
  );

  if (targetId !== undefined) {
    return (
      <a
        {...common}
        href={`#${targetId}`}
        data-target-id={targetId}
        aria-label={`Jump to ${label}`}
        title={`Jump to ${label}`}
        className={cn(
          SOURCE_CHIP,
          "cursor-pointer hover:border-accent-line hover:bg-raised hover:text-ink",
        )}
      >
        {content}
      </a>
    );
  }

  if (reviewId.length === 0) {
    return (
      <span {...common} data-navigable="false" className={SOURCE_CHIP}>
        {content}
      </span>
    );
  }

  return (
    <button
      {...common}
      type="button"
      disabled={pending}
      aria-label={`Open ${label} in editor`}
      title={`${source.path}${source.line === undefined ? "" : `:${source.line}`}`}
      onClick={() =>
        void openInEditor({
          reviewId,
          path: source.path,
          ...(source.line === undefined ? {} : { line: source.line }),
        }).catch(() => undefined)
      }
      className={cn(
        SOURCE_CHIP,
        "cursor-pointer hover:border-accent-line hover:bg-raised hover:text-ink disabled:cursor-default disabled:opacity-60",
      )}
    >
      {content}
    </button>
  );
}

export function SourceChips({
  sources,
  kind = "source",
  className,
  targetForSource,
}: {
  readonly sources: readonly SourceRef[];
  readonly kind?: SourceChipKind;
  readonly className?: string;
  readonly targetForSource?: (source: SourceRef) => string | undefined;
}) {
  if (sources.length === 0) return null;
  return (
    <div
      data-kind={`${kind}-chips`}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {sources.map((source) => (
        <SourceChip
          key={`${source.candidate ?? ""}:${source.path}:${source.line ?? ""}:${source.label ?? ""}`}
          source={source}
          kind={kind}
          targetId={targetForSource?.(source)}
        />
      ))}
    </div>
  );
}
