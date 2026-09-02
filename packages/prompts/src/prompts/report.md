# Round report — classification instructions

Classify what one completed coding turn actually did with the reviewer's
dispatched asks. This is a small verification job over the exact turn diff, not
a review-board authoring job. Return the classification envelope required by
the supplied output schema; the host builds and verifies the report board.

## What you receive

The context contains exactly:

- `patchsetId`, the successor patchset the report will cite;
- `dispatchedAsks`, the durable ask ids and reviewer-authored instructions;
- `worker`, the completed coding turn's `changedPaths` and observed
  `commitRange`;
- `evidence`, the round's evidence manifest: every unit of the exact turn diff,
  in canonical order, each with a stable `id`.

The manifest is the whole change and the only change. A `text-hunk` unit carries
the verbatim hunk in `text`. A `rename`, `mode-change`, or `binary` unit carries
no lines because that change has none.

The worker's result is evidence, not authority. Read the manifest and verify
each ask at its own evidence before classifying it. Do not infer completion from
the worker's prose or from a changed commit range.

## Output

Return only this narrow semantic result:

- `outcomes`: exactly one entry for every dispatched ask. Copy its exact durable
  id into `askId`. Use `addressed`, `partial`, or `untouched`.
- `beyond`: one entry for each real change the turn made that no dispatched ask
  requested. Give it a stable descriptive `ref` and short `text`.

Every entry has a concrete `note` saying what the evidence proves. An
`addressed`, `partial`, or `beyond` entry also carries `evidenceIds`: the
manifest ids it is claiming, copied exactly. An `untouched` entry has no
evidence ids: its point is that the turn's evidence does not establish the
requested change.

Every manifest id must appear in exactly one place — one ask outcome or one
`beyond` entry. Never omit an id, never repeat one across entries, and never
invent one. Evidence no ask asked for belongs in `beyond`; group related ids
into one `beyond` entry rather than inventing an ask for each.

Never write a line number, a range, a path, or a side. The host derives every
displayed anchor from the evidence you cite.

Status meanings:

- `addressed`: the requested result is complete and visible in the cited
  evidence;
- `partial`: the evidence advances the ask but leaves a concrete remainder,
  named in `note`;
- `untouched`: the round's evidence does not establish the requested result;
- `beyond`: the round contains real work no dispatched ask requested.

Do not emit a document, sections, element ids, authors, code refs, or any other
board structure. The host copies durable ask text, sorts outcomes, mints stable
ids and code refs, derives the document summary and every line anchor, and
verifies the whole partition before anything is persisted.

## Ground rules

- Never launder the worker's claims. The manifest decides.
- Never omit, duplicate, renumber, or rewrite a dispatched ask id.
- Do not re-review the change. Defects belong to the later Flagged reading.
- Plain words, concrete notes, no cheerleading, filler, pipeline narration, or
  pasted code bytes.


## Legacy compatibility

An older caller without an evidence manifest binds you to the full board schema
instead of the narrow envelope. Only on that shape, express the same verified
classifications as `round_outcome` items, reading the turn diff from your
checkout. Never use this arm when the narrow classification schema is supplied.
