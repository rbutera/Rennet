import { Row, Section } from "../atoms";

// ─────────────────────────────────────────────────────────────────────────────
// The Projects → Worktrees section — WHERE A REVIEW ACTUALLY WORKS (#812).
//
// This card used to offer a worktree location and a `{project}-{branch}` naming
// pattern, with a live preview of the folder they resolved to. Both persisted, and
// neither reached the code that places a worktree: since session-bound-workspace a
// session binds ONCE, and the path is `branchWorktreePath(dataDir, repoKey, branch)` —
// the repository's escaped path, then the branch as path segments. The preview was a
// promise the binding does not keep, so the editors are gone and the card states the
// four cases the binding actually has.
//
// The real path is not printable here, and saying `~/.rennet/worktrees/<repo>/<branch>`
// would have been a third wrong path rather than a fix (#816 review). Two reasons:
// `branchWorktreePath` lives in `@rennet/adapters` (Node), which app-ui may not import and
// which resolves against the DATA DIRECTORY — `~/.rennet` only by default, and a daemon
// started elsewhere puts them elsewhere. And the middle segment is not a repository name:
// it is `escapePath(realpath(repoRoot))`, the repository's whole absolute path with its
// separators escaped, which R19 keeps off the wire anyway. So the card names the SHAPE in
// words that hold for every data directory, and no path a reader could copy wrongly.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a workspace comes from, in the mono voice the rest of the settings paths use. */
function Shape({ children }: { readonly children: string }) {
  return (
    <span data-slot="worktree-shape" className="font-mono text-xs text-ink">
      {children}
    </span>
  );
}

export function WorktreeSection() {
  return (
    <Section title="Worktrees" caption="Rennet's data directory, in worktrees/">
      <Row
        label="A branch you already have out"
        hint="the review binds to that checkout — usually yours. Rennet creates nothing."
      >
        <Shape>your own checkout</Shape>
      </Row>
      <Row
        label="A branch nothing has out"
        hint="Rennet checks it out under its data directory, in worktrees/, filed by repository and then by branch — the repository's full path, escaped, and the branch as folders"
      >
        <Shape>a worktree Rennet makes</Shape>
      </Row>
      <Row
        label="A pull request"
        hint="under the same worktrees/ directory, filed by owner and repository as pr-<number> — a detached checkout at the reviewed commit, re-pinned in place when that commit moves"
      >
        <Shape>a detached checkout</Shape>
      </Row>
      <Row
        label="A coding round"
        hint="runs as a turn in the session's workspace and commits there — no worktree of its own"
      >
        <Shape>the session's workspace</Shape>
      </Row>
    </Section>
  );
}
