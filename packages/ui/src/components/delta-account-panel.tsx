import type { DeltaAccount, DeltaAskStatus } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// The DELTA RE-REVIEW ACCOUNT (issue #73). Rendered at the TOP of a successor
// review — the entry to delta re-review (journey stage 7) — it states, before the
// reviewer re-reads a line, what the returned patchset did:
//   • "What moved" — each staged ask as addressed / partially addressed / untouched.
//   • "Beyond your asks" — every path the successor changed that NO ask targeted,
//     surfaced LOUDLY (the scope-creep the reviewer must see).
//
// Every fact here is the DETERMINISTIC account (`buildDeltaAccount`, model-free); this
// component only renders it. It is INFORMATIONAL — it gates nothing (Rule Zero): the
// reviewer reads on and signs without dismissing it. Each item ANCHORS: activating it
// navigates the diff to that path (`onAnchor`).
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<DeltaAskStatus, string> = {
  addressed: "Addressed",
  "partially-addressed": "Partially addressed",
  untouched: "Untouched",
};

export function DeltaAccountPanel({
  account,
  onAnchor,
}: {
  account: DeltaAccount;
  /** Navigate the diff to `path` (the moved hunk[s]) — the account's anchor. */
  onAnchor: (path: string) => void;
}) {
  const hasAsks = account.asks.length > 0;
  const hasBeyond = account.beyondAsks.length > 0;
  if (!hasAsks && !hasBeyond) return null;

  return (
    <section
      className="delta-account"
      data-testid="delta-account"
      aria-label="Delta re-review account"
    >
      <p className="delta-account-eyebrow">Since you last reviewed</p>

      {hasAsks ? (
        <ul className="delta-account-asks">
          {account.asks.map((ask) => (
            <li
              key={`${ask.path}:${ask.side ?? ""}:${ask.span?.startLine ?? ""}:${ask.span?.endLine ?? ""}`}
              className="delta-account-ask"
              data-status={ask.status}
            >
              <button
                type="button"
                className="delta-account-item"
                onClick={() => onAnchor(ask.path)}
              >
                <span className="delta-account-status" data-status={ask.status}>
                  {STATUS_LABEL[ask.status]}
                </span>
                <code className="delta-account-path">{ask.path}</code>
                {ask.summary ? <span className="delta-account-summary">{ask.summary}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {hasBeyond ? (
        <div className="delta-account-beyond" data-testid="delta-account-beyond" role="alert">
          <p className="delta-account-beyond-title">
            {account.beyondAsks.length} change{account.beyondAsks.length === 1 ? "" : "s"} beyond
            your asks
          </p>
          <ul className="delta-account-beyond-list">
            {account.beyondAsks.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  className="delta-account-item delta-account-beyond-item"
                  onClick={() => onAnchor(path)}
                >
                  <code className="delta-account-path">{path}</code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
