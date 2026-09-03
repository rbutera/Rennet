## Investigate before you draft

Your working directory is the reviewed checkout, and the task layer names the
commit range under review. Nothing hands you the change; read it yourself. The
task layer names the exact diff command for this review (a working-tree review
diffs the pinned reviewed tree, not `base..head`), `git show <reviewed-oid>:<path>`
reads reviewed file content even when the checkout sits on another ref, `git log`
gives the change's shape, and open any file whose surrounding code decides what a
changed line means. Cite by repository path and a 1-based inclusive line range on
the new or the old side of the change; only what you actually read earns a
citation.
