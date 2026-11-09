import { useCallback, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// A preparation control's own failure, said in place.
//
// Retry, Cancel and Skip large files are writes. Fired as `void mutate(...)`, a rejection —
// a dropped connection, a daemon that refused — went nowhere: an unhandled rejection in the
// console and a button that silently did nothing. Each control now runs its write through
// `run`, and a failure becomes one plain sentence beside it.
// ─────────────────────────────────────────────────────────────────────────────

export interface ActionFailure {
  /** The sentence to show, or undefined when the last attempt did not fail. */
  readonly message: string | undefined;
  /** Run a write; a rejection becomes `message` instead of escaping. */
  readonly run: (write: () => Promise<unknown>, message: string) => void;
}

export function useActionFailure(): ActionFailure {
  const [message, setMessage] = useState<string | undefined>();
  const run = useCallback((write: () => Promise<unknown>, failed: string) => {
    setMessage(undefined);
    write().catch(() => setMessage(failed));
  }, []);
  return { message, run };
}

export function ActionFailureLine({ message }: { readonly message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p role="alert" data-slot="action-failure" className="text-danger text-sm">
      {message}
    </p>
  );
}
