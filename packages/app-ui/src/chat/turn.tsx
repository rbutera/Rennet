import { memo } from "react";
import { CodeBlock } from "../review";
import { ActionStep } from "./action-step";
import type { ActivityStep, ContentBlock, TranscriptBlock, TurnRow } from "./chat-data";
import { StreamingProse } from "./streaming-prose";
import { ThoughtBlock } from "./thought-block";

// ─────────────────────────────────────────────────────────────────────────────
// Turn (C07, ported from the spike). A user bubble, or an orchestrator turn: lead
// prose, an activity preface (thought blocks + action steps), then a body of prose /
// code blocks. Code renders through C4's shared `review/code-block.tsx` (reconciliation
// 4), never a local one — chat code and board code stay one path, one comment slice.
//
// The record-vs-arrival distinction is kept via `animate`: historical turns replay
// instantly; only turns arriving live word-fade in. The spike's `setTimeout`-gated
// "prefaceDone" reveal is GONE (reconciliation 2) — a live turn's body simply arrives
// after its thoughts through the stream fold, so no self-timed sequencing is needed.
// ─────────────────────────────────────────────────────────────────────────────

/** The activity preface: thought blocks and action steps, each reading its own status. */
function ActivitySequence({ steps }: { readonly steps: readonly ActivityStep[] }) {
  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {steps.map((step) =>
        step.kind === "thought" ? (
          <ThoughtBlock key={step.id} step={step} />
        ) : (
          <ActionStep key={step.id} step={step} />
        ),
      )}
    </div>
  );
}

type TranscriptGroup =
  | { readonly kind: "activity"; readonly steps: ActivityStep[]; readonly index: number }
  | { readonly kind: "content"; readonly block: ContentBlock; readonly index: number };

/**
 * Consecutive activity blocks are ONE sequence. The projected transcript is a flat log, and
 * wrapping each activity block in its own `ActivitySequence` put the transcript's 12px
 * block gap between steps that belong to one another — a preface reading as three separate
 * events instead of one train of thought. Grouping restores the sequence's own 6px rhythm
 * and leaves the 12px gap where it means something: between a preface and the prose.
 *
 * The group's key is the index of its FIRST block, so keys stay positional and unique.
 */
function groupActivity(blocks: readonly TranscriptBlock[]): readonly TranscriptGroup[] {
  const out: TranscriptGroup[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.kind !== "thought" && block.kind !== "action") {
      out.push({ kind: "content", block, index });
      continue;
    }
    const previous = out.at(-1);
    if (previous?.kind === "activity") previous.steps.push(block);
    else out.push({ kind: "activity", steps: [block], index });
  }
  return out;
}

function OrderedTranscript({
  blocks,
  animate,
}: {
  readonly blocks: readonly TranscriptBlock[];
  readonly animate: boolean;
}) {
  let lastUnresolvedActivity = -1;
  for (const [index, block] of blocks.entries()) {
    if ((block.kind === "thought" || block.kind === "action") && block.status === "streaming") {
      lastUnresolvedActivity = index;
    }
  }
  const visibleBlocks =
    lastUnresolvedActivity === -1 ? blocks : blocks.slice(0, lastUnresolvedActivity + 1);
  return (
    <div className="flex max-w-[640px] flex-col gap-3">
      {/* Keys are the group's position in the projected log, which is a fixed positional
          record — the same key rule the flat map used, carried onto the groups. */}
      {groupActivity(visibleBlocks).map((group) => {
        const index = group.index;
        if (group.kind === "activity") {
          return <ActivitySequence key={index} steps={group.steps} />;
        }
        const block = group.block;
        if (block.kind === "text") {
          return (
            <StreamingProse
              key={index}
              animate={animate}
              paragraphs={[block.text]}
              className="font-prose text-15 leading-relaxed text-foreground/90"
            />
          );
        }
        return (
          <CodeBlock
            key={index}
            path={block.path}
            code={block.code}
            startLine={block.startLine}
            highlightLines={block.highlightLines}
          />
        );
      })}
    </div>
  );
}

interface TurnProps {
  readonly turn: TurnRow;
  /** true only for turns arriving live; historical turns render as records. */
  readonly animate?: boolean;
}

function TurnImpl({ turn, animate = false }: TurnProps) {
  if (turn.speaker === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-lg bg-secondary px-3.5 py-2.5 font-prose text-15 leading-relaxed text-foreground/95">
          {turn.paragraphs.map((paragraph, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are a fixed positional list.
            <p key={index} className={index > 0 ? "mt-2" : undefined}>
              {paragraph}
            </p>
          ))}
        </div>
        {turn.time && <span className="text-2xs text-muted-foreground/50">{turn.time}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {turn.lead && (
        <StreamingProse
          animate={animate}
          paragraphs={[turn.lead]}
          className="max-w-[640px] font-prose text-15 leading-relaxed text-foreground/90"
        />
      )}
      {turn.blocks && turn.blocks.length > 0 ? (
        <OrderedTranscript blocks={turn.blocks} animate={animate} />
      ) : (
        <>
          {turn.preface && turn.preface.length > 0 && <ActivitySequence steps={turn.preface} />}
          {turn.body && turn.body.length > 0 ? (
            <div className="flex max-w-[640px] flex-col gap-3">
              {turn.body.map((block, index) =>
                block.kind === "text" ? (
                  <StreamingProse
                    // biome-ignore lint/suspicious/noArrayIndexKey: body blocks are a fixed positional list.
                    key={index}
                    animate={animate}
                    paragraphs={[block.text]}
                    className="font-prose text-15 leading-relaxed text-foreground/90"
                  />
                ) : (
                  <CodeBlock
                    // biome-ignore lint/suspicious/noArrayIndexKey: body blocks are a fixed positional list.
                    key={index}
                    path={block.path}
                    code={block.code}
                    startLine={block.startLine}
                    highlightLines={block.highlightLines}
                  />
                ),
              )}
            </div>
          ) : (
            turn.paragraphs.length > 0 && (
              <StreamingProse
                animate={animate}
                paragraphs={turn.paragraphs}
                className="max-w-[640px] font-prose text-15 leading-relaxed text-foreground/90"
              />
            )
          )}
        </>
      )}
    </div>
  );
}

/**
 * MEMOIZED (perf audit §5 H8). Every `ask-delta` rebuilds the transcript rows array, so
 * without this every settled turn in a long session re-rendered — re-grouping its blocks,
 * re-splitting every paragraph — on each streamed token. The memo is only worth anything
 * because Wave 2 made row identity stable: `chat-data.ts` memoizes a settled thread's rows
 * on the thread object in a WeakMap, and `foldAskStream` keeps every thread it did not
 * touch by reference, so `turn` is the SAME object across a delta and the shallow compare
 * holds. `animate` is a boolean off `liveIds.has(row.id)`. If either ever starts arriving
 * as a fresh value per delta, this silently stops helping — `conversation.dom.test.tsx`'s
 * render-count probe is what would notice.
 */
export const Turn = memo(TurnImpl);
