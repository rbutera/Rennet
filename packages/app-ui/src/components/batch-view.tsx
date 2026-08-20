import type { DispositionType } from "@rennet/types";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@rennet/ui";
import { batchViewModel, type DispositionBatch, type DispositionDraft } from "../canvas/authoring";
import type { BatchDestination } from "../canvas/destination";

// The STAGED view (issue #17; renamed per Rai's ruling 2026-08-07 — withdraw ==
// unstage): EXACTLY what will publish (someone else's PR) or hand off (own branch).
// It renders `batchViewModel(batch)` — the same derived list `batchPayload`
// serialises — so the reviewer sees the precise payload before it leaves. Edit the
// raw body / type in place; withdraw (unstage) removes an entry entirely (zero
// residue). `BatchDestination` now lives in `canvas/destination.ts` (the #64 north).

export type { BatchDestination } from "../canvas/destination";

const DESTINATION_COPY: Record<BatchDestination, string> = {
  publish: "Will publish to the pull request",
  handoff: "Will open a pull request on your branch",
};

const TYPES: DispositionType[] = ["approve", "request-change", "comment", "question"];

export function BatchView({
  batch,
  destination = "publish",
  onEditBody,
  onEditType,
  onWithdraw,
  onPublish,
}: {
  batch: DispositionBatch;
  destination?: BatchDestination;
  onEditBody?: (path: string, raw: string) => void;
  onEditType?: (path: string, type: DispositionType) => void;
  onWithdraw?: (path: string) => void;
  onPublish?: () => void;
}) {
  // Render the payload view model, not the raw batch, so what is shown is exactly
  // what serialises — the byte-for-byte publish/handoff payload.
  const entries = batchViewModel(batch);
  const draftFor = (path: string): DispositionDraft | undefined =>
    batch.find((draft) => draft.path === path);

  return (
    <section
      className="batch-view flex flex-col gap-3 rounded-surface border border-line bg-surface p-4 font-sans"
      aria-label="Staged dispositions"
    >
      <header className="batch-header flex items-baseline gap-2">
        <span className="batch-title text-sm font-semibold text-ink">Staged</span>
        <span className="batch-destination text-xs text-ink-soft">
          {DESTINATION_COPY[destination]}
        </span>
        <span className="batch-count ml-auto text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          {entries.length} staged
        </span>
      </header>
      {entries.length === 0 ? (
        <p className="batch-empty m-0 py-6 text-center text-sm text-ink-faint">
          Nothing staged. Dispose something and it stages here.
        </p>
      ) : (
        <ol className="batch-entries m-0 flex list-none flex-col gap-2 p-0">
          {entries.map((entry) => (
            <li
              className="batch-entry flex flex-wrap items-center gap-2 rounded-control border border-line bg-raised p-3"
              data-path={entry.path}
              data-type={entry.type}
              key={entry.path}
            >
              <span className="batch-entry-path min-w-0 flex-1 truncate font-mono text-sm text-ink">
                {entry.path}
              </span>
              <Select
                value={entry.type}
                onValueChange={(value) => onEditType?.(entry.path, value as DispositionType)}
              >
                <SelectTrigger className="batch-entry-type" aria-label={`Type for ${entry.path}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Textarea
                className="batch-entry-body resize-y leading-relaxed"
                aria-label={`Body for ${entry.path}`}
                value={draftFor(entry.path)?.raw ?? entry.body}
                placeholder="Raw note — lazy is fine"
                onChange={(event) => onEditBody?.(entry.path, event.target.value)}
              />
              <Button
                variant="destructive"
                className="batch-entry-withdraw"
                onClick={() => onWithdraw?.(entry.path)}
              >
                Withdraw
              </Button>
            </li>
          ))}
        </ol>
      )}
      {entries.length > 0 ? (
        <footer className="batch-footer flex">
          <Button size="lg" className="batch-publish text-base" onClick={() => onPublish?.()}>
            {destination === "publish" ? "Publish to PR" : "Hand off"}
          </Button>
        </footer>
      ) : null}
    </section>
  );
}
