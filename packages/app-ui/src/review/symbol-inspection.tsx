import { Popover, PopoverContent } from "@rennet/ui";
import {
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { splitIdentifierRuns, tokenTextMayContainSymbol } from "../canvas/symbol";
import { SymbolInspector } from "../components/symbol-inspector";
import { useCommand, useMutation, useRefreshCommand } from "../data";
import type { Token } from "../syntax/shiki";

const SymbolInspectionContext = createContext<{
  readonly patchsetId: string;
  inspect(name: string, anchor: HTMLButtonElement): void;
} | null>(null);

export function SymbolInspectionProvider({
  reviewId,
  patchsetId,
  children,
}: {
  readonly reviewId?: string;
  readonly patchsetId?: string;
  readonly children: ReactNode;
}) {
  const [selection, setSelection] = useState<{
    readonly name: string;
    readonly anchor: HTMLButtonElement;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: review and patchset are the lookup's invalidation keys.
  useEffect(() => setSelection(null), [reviewId, patchsetId]);
  const refresh = useRefreshCommand("review.symbolLookup");
  const inspect = useCallback(
    (name: string, anchor: HTMLButtonElement) => {
      if (window.getSelection()?.isCollapsed === false) return;
      // The command is keyed by review and name, while recapture advances that review.
      refresh();
      setSelection({ name, anchor });
    },
    [refresh],
  );
  const source = useMemo(
    () => (reviewId && patchsetId ? { patchsetId, inspect } : null),
    [reviewId, patchsetId, inspect],
  );

  return (
    <SymbolInspectionContext.Provider value={source}>
      <Popover
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
      >
        {children}
        {selection && reviewId ? (
          <PopoverContent
            anchor={selection.anchor}
            finalFocus={() => selection.anchor}
            align="start"
            className="max-h-[70vh] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
            aria-label={`Inspect ${selection.name}`}
          >
            <SymbolLookup
              key={selection.name}
              reviewId={reviewId}
              name={selection.name}
              onClose={() => setSelection(null)}
            />
          </PopoverContent>
        ) : null}
      </Popover>
    </SymbolInspectionContext.Provider>
  );
}

function SymbolLookup({
  reviewId,
  name,
  onClose,
}: {
  readonly reviewId: string;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const lookup = useCommand("review.symbolLookup", { reviewId, name });
  const { mutate: openInEditor, error: editorError } = useMutation("review.openInEditor");
  const [editorUnavailable, setEditorUnavailable] = useState(false);
  return (
    <>
      <p className="px-4 pt-3 text-xs text-muted-foreground">
        Indexed at the reviewed commit; local edits are not indexed.
      </p>
      <SymbolInspector
        name={name}
        pending={lookup.pending || lookup.stale || lookup.fetching}
        inspection={lookup.stale || lookup.fetching ? undefined : lookup.data}
        error={lookup.error === undefined ? undefined : String(lookup.error)}
        onClose={onClose}
        onOpenInEditor={(path, line) => {
          setEditorUnavailable(false);
          void openInEditor({ reviewId, path, line })
            .then(({ ok }) => setEditorUnavailable(!ok))
            .catch(() => undefined);
        }}
      />
      {editorError || editorUnavailable ? (
        <p role="alert" className="px-4 pb-3 text-xs text-danger">
          {editorError ? String(editorError) : "Rennet could not open the editor on this host."}
        </p>
      ) : null}
    </>
  );
}

export function SymbolTokens({
  tokens,
  patchsetId,
  enabled = true,
}: {
  readonly tokens: readonly Token[];
  readonly patchsetId?: string;
  readonly enabled?: boolean;
}) {
  const source = useContext(SymbolInspectionContext);
  const inspect =
    enabled && (patchsetId === undefined || patchsetId === source?.patchsetId)
      ? source?.inspect
      : undefined;
  let column = 0;
  return tokens.map((token) => {
    const key = column;
    column += token.text.length;
    return (
      <span key={key} className={`rtok rtok-${token.type}`}>
        {inspect && tokenTextMayContainSymbol(token.type, token.text)
          ? splitIdentifierRuns(token.text).map((segment, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are fixed positions within this token.
              <Fragment key={index}>
                {segment.isIdentifier ? (
                  <button
                    type="button"
                    className="rtok-symbol"
                    data-symbol={segment.text}
                    aria-label={`Inspect ${segment.text}`}
                    title={`Inspect ${segment.text}`}
                    onClick={(event) => inspect(segment.text, event.currentTarget)}
                  >
                    {segment.text}
                  </button>
                ) : (
                  segment.text
                )}
              </Fragment>
            ))
          : token.text}
      </span>
    );
  });
}
