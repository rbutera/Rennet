import type { DispositionType } from "@rennet/types";
import { batchViewModel, type DispositionBatch, type DispositionDraft } from "../canvas/authoring";

// The batch view: EXACTLY what will publish (someone else's PR) or hand off (own
// branch). It renders `batchViewModel(batch)` — the same derived list `batchPayload`
// serialises — so the reviewer sees the precise payload before it leaves. Edit the
// raw body / type in place; withdraw removes an entry entirely (zero residue).

/** Whether this batch will publish onto a PR or hand off on the reviewer's own branch. */
export type BatchDestination = "publish" | "handoff";

const DESTINATION_COPY: Record<BatchDestination, string> = {
  publish: "Will publish to the pull request",
  handoff: "Will hand off on your branch",
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
    <section className="batch-view" aria-label="Disposition batch">
      <header className="batch-header">
        <span className="batch-destination">{DESTINATION_COPY[destination]}</span>
        <span className="batch-count">
          {entries.length} disposition{entries.length === 1 ? "" : "s"}
        </span>
      </header>
      {entries.length === 0 ? (
        <p className="batch-empty">Nothing staged. Author a disposition to add it here.</p>
      ) : (
        <ol className="batch-entries">
          {entries.map((entry) => (
            <li
              className="batch-entry"
              data-path={entry.path}
              data-type={entry.type}
              key={entry.path}
            >
              <span className="batch-entry-path">{entry.path}</span>
              <select
                className="batch-entry-type"
                aria-label={`Type for ${entry.path}`}
                value={entry.type}
                onChange={(event) =>
                  onEditType?.(entry.path, event.target.value as DispositionType)
                }
              >
                {TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <textarea
                className="batch-entry-body"
                aria-label={`Body for ${entry.path}`}
                value={draftFor(entry.path)?.raw ?? entry.body}
                placeholder="Raw note — lazy is fine"
                onChange={(event) => onEditBody?.(entry.path, event.target.value)}
              />
              <button
                type="button"
                className="batch-entry-withdraw"
                onClick={() => onWithdraw?.(entry.path)}
              >
                Withdraw
              </button>
            </li>
          ))}
        </ol>
      )}
      {entries.length > 0 ? (
        <footer className="batch-footer">
          <button type="button" className="batch-publish" onClick={() => onPublish?.()}>
            {destination === "publish" ? "Publish to PR" : "Hand off"}
          </button>
        </footer>
      ) : null}
    </section>
  );
}
