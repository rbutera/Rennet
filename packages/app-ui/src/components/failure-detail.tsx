import { cn } from "@rennet/ui";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Icon } from "./icon";

/**
 * Raw failure output behind a Details disclosure. The output is rendered only while the
 * disclosure is open, so it is never on the page — or in a screen reader's way — until the
 * reviewer asks for it. Shared by the preparation failure block and a failed lens board, so
 * the daemon's own words are always one click away and never the headline.
 */
export function FailureDetail({ detail }: { readonly detail: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      data-slot="failure-detail"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group text-sm"
    >
      <summary className="flex w-fit cursor-default list-none items-center gap-1 text-ink-soft text-xs hover:text-ink [&::-webkit-details-marker]:hidden">
        <Icon
          icon={ChevronRight}
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        Details
      </summary>
      {open ? (
        <pre
          data-slot="failure-detail-output"
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-raised p-3 font-mono text-2xs text-ink-soft"
        >
          {detail}
        </pre>
      ) : null}
    </details>
  );
}
