# live-review-pipeline

Delivery of the real per-element diff material with the live canvas set, so zooming into a canvas element renders the real captured hunk content.

## ADDED Requirements

### Requirement: The canvas response carries a real per-element diff map

`buildReviewCanvases` SHALL produce, alongside the five-angle canvas set, an `elementDiffs` map keyed by `elementKey`. Each entry SHALL carry the changed file `path` and the `diff` text sliced **verbatim** from the captured `Patchset` — never reconstructed from separated add/delete/context arrays, and never a fixture. The `review.canvases` command output SHALL deliver this map to the renderer.

The map SHALL be a pure function of `(canvases, decomposition, patchset)`: identical inputs SHALL yield an identical map.

#### Scenario: a chunk element resolves to its real captured hunk

- **WHEN** `buildReviewCanvases` runs on a real patchset (deterministic floor, no model turn)
- **THEN** the sequence canvas's chunk element has an `elementDiffs` entry whose `path` is the changed file
- **AND** the entry's `diff` contains the real added and context lines exactly as captured in the patch
- **AND** the `diff` contains no `demoDiff` fixture signature

#### Scenario: a doc-anchored element has no diff

- **WHEN** an element's anchor is not a `chunk` or `hunk` anchor (a flat-angle document element)
- **THEN** it has no `elementDiffs` entry, so the zoom surface renders nothing rather than a fixture

### Requirement: The zoom surface renders the real diff on the real path

The canvas UI SHALL render the `elementDiffs` diff for the selected element when a real review is loaded, replacing the `demoDiff` fixture. The fixtures demo path SHALL be unchanged: when no real canvas set has loaded, zooming SHALL still render the demo diff, so the clickable demo never regresses.

#### Scenario: real review shows real code

- **WHEN** a real canvas set has loaded and the user zooms into an element that has an `elementDiffs` entry
- **THEN** the diff surface renders that real diff, not `demoDiff`

#### Scenario: the fixtures demo is preserved

- **WHEN** no real canvas set has loaded (the fixtures demo is on screen)
- **THEN** zooming still renders the demo diff, unchanged
