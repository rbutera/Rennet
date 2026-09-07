import { type CodeRef, type CommandOutput, isTestPath } from "@rennet/protocol";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCommand } from "../data";
import { CodeBlock } from "./code-block";
import { type NumberedLine, numberLines, parsePatch } from "./diff-parse";

type Evidence = CommandOutput<"patchset.readEvidence">;

export function evidenceRows(
  data: Evidence,
  citation: CodeRef,
  context: number | "all",
): NumberedLine[] {
  const hunks = parsePatch(data.patch);
  const relevant = hunks.filter((hunk) =>
    numberLines(hunk).some((line) => {
      const n = citation.side === "base" ? line.oldLine : line.newLine;
      return n !== null && n >= citation.startLine && n <= citation.endLine;
    }),
  );
  if (context === 0 && relevant.length > 0) return relevant.flatMap(numberLines);
  if (data.base == null && data.head == null) return relevant.flatMap(numberLines);
  const baseOnly = data.head == null;
  const source = (data.head ?? data.base ?? "").replace(/\n$/, "").split("\n");
  const rows: NumberedLine[] = [];
  let old = 1;
  let next = 1;
  for (const hunk of hunks) {
    while (
      baseOnly
        ? old < hunk.oldStart && old <= source.length
        : next < hunk.newStart && next <= source.length
    ) {
      rows.push({
        type: "context",
        text: source[(baseOnly ? old : next) - 1] ?? "",
        oldLine: old++,
        newLine: baseOnly ? null : next++,
      });
    }
    const numbered = numberLines(hunk);
    rows.push(...numbered);
    for (const row of numbered) {
      if (row.oldLine !== null) old = row.oldLine + 1;
      if (row.newLine !== null) next = row.newLine + 1;
    }
  }
  while ((baseOnly ? old : next) <= source.length)
    rows.push({
      type: "context",
      text: source[(baseOnly ? old : next) - 1] ?? "",
      oldLine: old++,
      newLine: baseOnly ? null : next++,
    });
  if (context === "all" || !hunks.length) return rows;
  const selected = new Set(
    (relevant.length ? relevant : hunks)
      .flatMap(numberLines)
      .map((row) => `${row.oldLine}:${row.newLine}`),
  );
  const indexes = rows.flatMap((row, i) =>
    selected.has(`${row.oldLine}:${row.newLine}`) ? [i] : [],
  );
  const referenced = rows.flatMap((row, i) => {
    const line = citation.side === "base" ? row.oldLine : row.newLine;
    return line !== null && line >= citation.startLine && line <= citation.endLine ? [i] : [];
  });
  const from = relevant.length ? indexes[0] : referenced[0];
  const to = relevant.length ? indexes.at(-1) : referenced.at(-1);
  if (from === undefined || to === undefined) return [];
  context = Math.max(context, 3);
  return rows.slice(Math.max(0, from - context), to + context + 1);
}

export function EvidenceBlock({ citation, initial }: { citation: CodeRef; initial: Evidence }) {
  const container = useRef<HTMLDivElement>(null);
  const origin = useRef<{
    context: number | "all";
    left: number;
    codeTop: number;
    scrollParent: HTMLElement | null;
    top: number;
  }>({ context: 0, left: 0, codeTop: 0, scrollParent: null, top: 0 });
  const restorePosition = useRef(false);
  const [destination, setDestination] = useState<CodeRef>(citation);
  const [context, setContext] = useState<number | "all">(0);
  const navigating = destination.path !== citation.path;
  const { data: fetched, error } = useCommand("patchset.readEvidence", {
    ref: destination,
    includeSource: context !== 0 || navigating,
  });
  const { data: relationships } = useCommand("patchset.readEvidence", {
    ref: destination,
    includeCounterparts: true,
  });
  const data = fetched ?? (!navigating ? initial : undefined);
  const counterparts = relationships?.counterparts ?? [];
  useLayoutEffect(() => {
    if (navigating || !restorePosition.current || !data) return;
    if (context !== 0 && fetched === undefined && error === undefined) return;
    const scroller = container.current?.querySelector<HTMLElement>("[data-code-scroll]");
    if (scroller) {
      scroller.scrollLeft = origin.current.left;
      scroller.scrollTop = origin.current.codeTop;
      scroller.dispatchEvent(new Event("scroll"));
    }
    if (origin.current.scrollParent) origin.current.scrollParent.scrollTop = origin.current.top;
    restorePosition.current = false;
  }, [navigating, data, context, fetched, error]);
  const back = () => {
    restorePosition.current = true;
    setDestination(citation);
    setContext(origin.current.context);
  };
  const control =
    "rounded px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-ring";
  const open = (path: string) => {
    if (path === citation.path && navigating) {
      back();
      return;
    }
    if (!navigating) {
      let scrollParent = container.current?.parentElement ?? null;
      while (scrollParent && scrollParent.scrollHeight <= scrollParent.clientHeight)
        scrollParent = scrollParent.parentElement;
      origin.current = {
        context,
        left: container.current?.querySelector<HTMLElement>("[data-code-scroll]")?.scrollLeft ?? 0,
        codeTop:
          container.current?.querySelector<HTMLElement>("[data-code-scroll]")?.scrollTop ?? 0,
        scrollParent,
        top: scrollParent?.scrollTop ?? 0,
      };
    }
    setDestination({ ...citation, path, side: "head", startLine: 1, endLine: 1 });
    setContext("all");
  };
  const rows = useMemo(
    () => (data ? evidenceRows(data, destination, context) : []),
    [data, destination, context],
  );
  return (
    <div ref={container} className="flex flex-col gap-1.5" data-evidence-path={destination.path}>
      <div className="flex flex-wrap items-center gap-1">
        {navigating && (
          <button type="button" className={control} onClick={back}>
            Back to review
          </button>
        )}
        {counterparts.length === 1 && (
          <button
            type="button"
            className={control}
            onClick={() => {
              const path = counterparts[0];
              if (path) open(path);
            }}
          >
            {isTestPath(destination.path) || /(?:^|\/)__tests__\//.test(destination.path)
              ? "View implementation"
              : "View test"}
          </button>
        )}
        {counterparts.length > 1 && (
          <details className="relative">
            <summary className={control}>
              {isTestPath(destination.path) ? "View implementation" : "View tests"}
            </summary>
            <div className="absolute z-20 flex min-w-64 flex-col rounded border border-border bg-popover p-1 shadow-overlay">
              {counterparts.map((path) => (
                <button
                  type="button"
                  className={`${control} text-left`}
                  key={path}
                  onClick={() => open(path)}
                >
                  {path}
                </button>
              ))}
            </div>
          </details>
        )}
        {context !== "all" && (
          <>
            <button
              type="button"
              className={control}
              onClick={() =>
                setContext((current) => (typeof current === "number" ? current + 20 : current))
              }
            >
              Expand context
            </button>
            <button type="button" className={control} onClick={() => setContext("all")}>
              Full file
            </button>
          </>
        )}
        {context === "all" && !navigating && (
          <button type="button" className={control} onClick={() => setContext(0)}>
            Cited hunks
          </button>
        )}
      </div>
      {error !== undefined && (
        <p className="text-xs text-muted-foreground">
          {error instanceof Error ? error.message : "The reviewed source could not be read."}
        </p>
      )}
      {data?.caption && <p className="text-xs text-muted-foreground">{data.caption}</p>}
      {!data ? (
        <p className="text-xs text-muted-foreground">Loading reviewed source…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {destination.path}:{destination.startLine}–{destination.endLine} ({destination.side}) is
          outside the available reviewed source.
        </p>
      ) : (
        <CodeBlock
          key={`${destination.path}:${destination.side}`}
          code={rows.map((row) => row.text).join("\n")}
          rows={rows}
          focusRef={destination}
          startLine={rows[0]?.newLine ?? rows[0]?.oldLine ?? 1}
          path={data.path}
          previousPath={data.previousPath}
          patchsetId={destination.patchsetId}
          counterpart={null}
        />
      )}
    </div>
  );
}
