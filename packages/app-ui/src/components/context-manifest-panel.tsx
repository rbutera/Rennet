import type { ContextDocumentRecord, ContextManifest } from "@rennet/protocol";
import { Button } from "@rennet/ui";

// ─────────────────────────────────────────────────────────────────────────────
// The context-composition inspector (issue #30). It shows the reviewer what Rennet
// assembled: every document in composition order with its source label, content hash, byte count, and
// included/truncated/dropped state, plus the assembled-prompt digest and (when
// available) the byte-identical assembled prompt itself.
//
// Modelled on `successor-account-panel.tsx`: deterministic, model-free, and gate-free
// (Rule Zero). It gates NOTHING — repo guidance already fed the pipeline; honesty
// is provided by SHOWING the truth (what was composed, what was cut), never by
// restricting what may be composed. There is no accept/trust/consent affordance
// anywhere in this panel, by design.
// ─────────────────────────────────────────────────────────────────────────────

const STATE_LABEL: Record<ContextDocumentRecord["state"], string> = {
  included: "Included",
  truncated: "Truncated",
  dropped: "Dropped",
};

/** A short, human-readable byte figure (raw bytes; no rounding that could hide a cut). */
function bytesLabel(record: ContextDocumentRecord): string {
  if (record.state === "included") return `${record.bytes} B`;
  if (record.state === "truncated") return `${record.bytes} of ${record.originalBytes} B`;
  return `0 of ${record.originalBytes} B`;
}

export function ContextManifestPanel({
  manifest,
  assembledContext,
  onOpenAssembledContext,
}: {
  manifest: ContextManifest;
  /**
   * The byte-identical context Rennet assembled, when available. When present the
   * panel shows it verbatim (never a reconstruction); its digest is
   * `manifest.assembledPromptDigest`, proven equal on the capture path.
   */
  assembledContext?: string;
  /** Reveal the assembled context (when the host loads it lazily). Optional. */
  onOpenAssembledContext?: () => void;
}) {
  // Render in composition order — sort by the recorded order position so the panel is
  // honest about the sequence regardless of array order.
  const documents = [...manifest.documents].sort((a, b) => a.order - b.order);
  const sends = manifest.sends ?? [];
  const hasProvenSend = sends.some(
    (send) => send.contextIncluded && send.contextDigest === manifest.assembledPromptDigest,
  );
  const panelLabel = hasProvenSend ? "Context sent to the fleet" : "Context Rennet assembled";

  return (
    <section
      className="context-manifest flex flex-col gap-2 border-b border-line bg-surface px-5 py-3"
      data-testid="context-manifest"
      aria-label={panelLabel}
    >
      <p className="context-manifest-eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        {panelLabel}
      </p>

      <p
        className="context-manifest-summary m-0 text-sm text-ink-soft"
        data-testid="context-manifest-summary"
      >
        {documents.length} document{documents.length === 1 ? "" : "s"} · {manifest.totalBytes} B
        assembled
      </p>

      {documents.length > 0 ? (
        <ol className="context-manifest-docs m-0 flex list-none flex-col gap-0.5 p-0">
          {documents.map((doc) => (
            <li
              key={`${doc.order}:${doc.sourcePath}`}
              className="context-manifest-doc flex items-baseline gap-2.5 rounded-chip px-2 py-1 data-[state=dropped]:opacity-70"
              data-testid="context-manifest-doc"
              data-state={doc.state}
            >
              <span
                className="context-manifest-source min-w-[92px] flex-none text-2xs font-semibold text-ink-soft"
                data-source={doc.source}
              >
                {doc.source}
              </span>
              <code className="context-manifest-path min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm text-ink-soft">
                {doc.sourcePath}
              </code>
              <span
                className="context-manifest-state flex-none text-2xs font-semibold data-[state=included]:text-green data-[state=truncated]:text-accent data-[state=dropped]:text-ink-faint"
                data-state={doc.state}
              >
                {STATE_LABEL[doc.state]}
              </span>
              <span className="context-manifest-bytes flex-none text-2xs tabular-nums text-ink-faint">
                {bytesLabel(doc)}
              </span>
              <code
                className="context-manifest-hash flex-none font-mono text-2xs text-ink-faint"
                title={doc.contentHash}
              >
                {doc.contentHash.slice(0, 12)}
              </code>
            </li>
          ))}
        </ol>
      ) : (
        <p
          className="context-manifest-empty m-0 text-2xs text-ink-faint"
          data-testid="context-manifest-empty"
        >
          No context documents were assembled for this dispatch.
        </p>
      )}

      {sends.length > 0 ? (
        <ol
          className="context-manifest-sends m-0 flex list-none flex-col gap-0.5 p-0"
          aria-label="Fleet context send transcript"
        >
          {sends.map((send) => {
            const digestMatches =
              send.contextIncluded && send.contextDigest === manifest.assembledPromptDigest;
            return (
              <li
                key={`${send.sentAt}:${send.seat}:${send.harness}:${send.attempt}:${send.promptDigest}`}
                className="context-manifest-send flex items-baseline gap-2.5 rounded-chip px-2 py-1 text-2xs text-ink-faint data-[context-included=false]:opacity-70"
                data-testid="context-manifest-send"
                data-context-included={send.contextIncluded}
                data-digest-match={digestMatches}
              >
                <span className="context-manifest-send-seat font-semibold text-ink-soft">
                  {send.seat}
                </span>
                <span className="context-manifest-send-harness font-semibold text-ink-soft">
                  {send.harness}
                </span>
                <span className="context-manifest-send-channel font-mono">{send.channel}</span>
                <span>Attempt {send.attempt}</span>
                <span>{send.promptBytes} B</span>
                <span>{send.contextIncluded ? "Included" : "Dropped"}</span>
                <span className={digestMatches ? "text-green" : undefined}>
                  {digestMatches
                    ? "Digest matches"
                    : send.contextIncluded
                      ? "Digest differs"
                      : "No context digest"}
                </span>
                <code className="font-mono" title={send.promptDigest}>
                  {send.promptDigest.slice(0, 12)}
                </code>
              </li>
            );
          })}
        </ol>
      ) : null}

      {/*
        Exhaustiveness is EVIDENCE, not optimism: until a context-isolation probe
        proves the harness sees only pipeline-assembled context, we say so and name
        the unmanaged sources, rather than claiming completeness we cannot prove.
      */}
      {!manifest.exhaustive ? (
        <p
          className="context-manifest-unmanaged m-0 text-2xs text-ink-faint"
          data-testid="context-manifest-unmanaged"
        >
          Not exhaustive — the harness may also read:{" "}
          {manifest.unmanagedSources.length > 0
            ? manifest.unmanagedSources.join("; ")
            : "(no unmanaged sources named)"}
        </p>
      ) : null}

      <div className="context-manifest-assembled flex flex-col gap-1 pt-1">
        <p className="context-manifest-assembled-title m-0 text-2xs font-semibold text-ink-soft">
          Assembled context
        </p>
        <code
          className="context-manifest-assembled-digest font-mono text-2xs text-ink-faint"
          data-testid="context-manifest-assembled-digest"
          title={manifest.assembledPromptDigest}
        >
          {manifest.assembledPromptDigest.slice(0, 16)}
        </code>
        {assembledContext !== undefined ? (
          <pre
            className="context-manifest-assembled-prompt m-0 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-control border border-line bg-code px-2.5 py-2 font-mono text-2xs leading-relaxed text-ink-soft"
            data-testid="context-manifest-assembled-prompt"
          >
            {assembledContext}
          </pre>
        ) : null}
        {assembledContext === undefined && onOpenAssembledContext ? (
          <Button
            variant="outline"
            size="xs"
            className="context-manifest-open self-start text-2xs text-ink-soft"
            data-testid="context-manifest-open"
            onClick={onOpenAssembledContext}
          >
            Open the assembled context
          </Button>
        ) : null}
      </div>
    </section>
  );
}
