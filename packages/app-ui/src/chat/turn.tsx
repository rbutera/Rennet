import { CodeBlock } from "../review";
import { ActionStep } from "./action-step";
import type { ActivityStep, TurnRow } from "./chat-data";
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

export function Turn({
  turn,
  animate = false,
}: {
  readonly turn: TurnRow;
  /** true only for turns arriving live; historical turns render as records. */
  readonly animate?: boolean;
}) {
  if (turn.speaker === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-lg bg-secondary px-3.5 py-2.5 font-serif text-sm leading-relaxed text-foreground/95">
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
          className="max-w-[640px] font-serif text-sm leading-relaxed text-foreground/90"
        />
      )}
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
                className="font-serif text-sm leading-relaxed text-foreground/90"
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
            className="max-w-[640px] font-serif text-sm leading-relaxed text-foreground/90"
          />
        )
      )}
    </div>
  );
}
