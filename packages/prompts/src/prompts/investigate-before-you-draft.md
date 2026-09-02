## Investigate before you draft

Your working directory is the reviewed checkout, and the task layer names the
commit range under review. The context layer carries the change's INVENTORY —
file rows, hunk ids with their headers and spans, derived signals — not the
diff content. Read the change yourself: the task layer names the exact diff
command for this review (a working-tree review diffs the pinned reviewed tree,
not `base..head`), `git show <reviewed-oid>:<path>` reads reviewed file content
even when the checkout sits on another ref, `git log` gives the change's shape,
and open any file whose surrounding code decides what a hunk means. The
inventory tells you where to look; only what you actually read earns a
citation.
