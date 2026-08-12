# Design — renderer-polish

## Current seams and the renderer boundary

The committed symbol behavior is deliberate and remains the default. `reviewPinnedToHead(review)` rewrites the active patchset's `repository.baseOid` to `headOid` (`apps/desktop/src/main/symbol-lookup-live.ts:44-55`), and desktop main applies that projection before composing the symbolic backend (`apps/desktop/src/main/index.ts:1420-1427`). The renderer currently exposes a one-argument `SymbolLookupPort` (`packages/ui/src/canvas/symbol.ts:111`) and binds it directly to `review.symbolLookup` (`packages/ui/src/app.tsx:1815-1819`).

That evidence fixes the package boundary: `packages/ui` can choose and display a lookup source, but it cannot generate or patch a filesystem-backed ProjectSnapshot. This renderer-only change therefore accepts two injected ports with the same `(name) => Promise<SymbolInspection>` shape:

- `symbolLookup`: the existing committed-head lookup, always the default.
- `workingTreeSymbolLookup`: the dependency-provided overlay lookup; optional at the component boundary and supplied by the live host before this slice is wired into the app.

No renderer code reconstructs an index from visible hunks. A diff contains neither the unchanged files nor enough source structure to produce honest definitions and references. The selector is absent until the second port exists, so the shipped surface never offers an action that cannot return the promised source.

## #223: source selection preserves peek-then-pin

`CanvasWorkspace` owns a small source value, `committed | working-tree`, derived synchronously for the active `reviewId`; an unseen review reads `committed`. The selector lives in fixed workspace chrome beside the existing zoom controls, not inside `SymbolInspector`. Changing it reissues the currently shown name through the newly selected port, replaces the current source's pending/result state, and discards cross-source breadcrumb answers so a committed result can never be labelled as working-tree or vice versa. Whether floating or pinned is preserved, and `CodeView` is untouched.

The canonical wireframe says plain click opens a floating peek, pin docks it, navigation stays inside the rail, and the diff never moves (`wireframes/src/11-symbol-inspector.html:187`, `:223`, `:226`). Its top bar shows a passive `snapshot` label but no source picker (`wireframes/src/11-symbol-inspector.html:188`), while #223's prose requires an opt-in beyond the committed default. **This is the wireframe-versus-issue conflict, and the wireframe wins:** the card and dock gain no new mode row or dialog. The required choice is a compact workspace-chrome selector in the wireframe's snapshot/status stratum; it is one direct action, not a confirmation or permission step.

The renderer state records the source per review for the life of the mounted workspace. That keeps every unseen review committed-by-default and makes returning to an already-open review unsurprising. It is session state only; persistence is not part of either issue.

## #240: one mounted workspace, state keyed by `reviewId`

The bug is exactly at `const [hypothesisOpen, setHypothesisOpen] = useState(true)` (`packages/ui/src/components/workspace.tsx:335`). `RennetApp` already derives the active `reviewId` (`packages/ui/src/app.tsx:541`) but mounts `CanvasWorkspace` without `key={reviewId}` (`packages/ui/src/app.tsx:1767-1773`), so React correctly preserves the component and its single boolean across review changes.

Keep the workspace mounted and pass `reviewId` as a required live identity. Inside it, store only the two requested polish values in a map keyed by review id. For hypothesis state:

```ts
hypothesisOpen = reviewUiById[reviewId]?.hypothesisOpen ?? true
```

The toggle writes only the active entry. A patchset regeneration does not change `reviewId`, so its frame stays as the reviewer left it. Opening a different review reads that review's entry or the expanded default in the same render; no reset effect creates a one-render leak.

## Tests and scope proof

The #223 DOM test mounts the real `CanvasWorkspace` over a clickable symbol with committed and working-tree ports returning distinct paths. It proves the initial click uses committed, the direct source switch re-resolves the visible symbol through working-tree, pinned placement remains pinned, and the diff element is unchanged. Reverting the routing leaves the working-tree marker absent.

The #240 DOM test mounts review A, collapses its real hypothesis frame, rerenders the same component as review B, then rerenders A. It proves B starts expanded and A restores collapsed; a rerender with A's canvases changed but the same review id stays collapsed. Replacing the map with the current boolean makes B inherit A's collapse and fails the test.

All implementation and tests remain under `packages/ui/src`. The existing `reviewPinnedToHead` main-process path, IPC schemas, snapshot builder, and symbolic result shapes are read-only dependencies for this change.
