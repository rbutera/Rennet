import { useRefreshCommand } from "../data/query";

export function ChatUnavailable({ slot }: { readonly slot: string }) {
  const retry = useRefreshCommand("chat.t3Session");
  return (
    <div data-slot={slot} role="alert" className="p-3 text-xs text-ink-soft">
      <p>Rennet couldn't start chat. Try again, or restart Rennet if it keeps happening.</p>
      <button type="button" onClick={retry} className="mt-2 underline underline-offset-2">
        Try again
      </button>
    </div>
  );
}
