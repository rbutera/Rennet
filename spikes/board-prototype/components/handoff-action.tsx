"use client"

import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

/**
 * The hand-off's one exit action, shared by both modes (R31): a full-size CTA
 * that shows the submission in flight before the lane swaps to its receipt.
 */
export function HandoffAction({
  label,
  postingLabel,
  icon: Icon,
  onPosted,
}: {
  label: string
  postingLabel: string
  icon: LucideIcon
  onPosted: () => void
}) {
  const [posting, setPosting] = React.useState(false)
  return (
    <Button
      size="lg"
      disabled={posting}
      onClick={() => {
        setPosting(true)
        window.setTimeout(onPosted, 1800)
      }}
      // Posting keeps full contrast: it is a live state, not an inert control.
      className="h-12 w-fit gap-2.5 px-7 text-[15px] font-semibold disabled:opacity-100"
    >
      {posting ? <Spinner className="size-4.5" /> : <Icon className="size-4.5" aria-hidden="true" />}
      {posting ? postingLabel : label}
    </Button>
  )
}
