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
// The real path is not computable here: `branchWorktreePath` lives in `@rennet/adapters`
// (Node), which app-ui may not import, and the repo key is a HOST path that R19 keeps off
// the wire. So the shape is written in words, with the placeholders named.
// ─────────────────────────────────────────────────────────────────────────────

/** One stated path shape, in the mono voice the rest of the settings paths use. */
function Shape({ children }: { readonly children: string }) {
  return (
    <span data-slot="worktree-shape" className="font-mono text-xs text-ink">
      {children}
    </span>
  );
}

export function WorktreeSection() {
  return (
    <Section title="Worktrees" caption="~/.rennet/worktrees">
      <Row
        label="A branch you already have out"
        hint="the review binds to that checkout — usually yours. Rennet creates nothing."
      >
        <Shape>your own checkout</Shape>
      </Row>
      <Row
        label="A branch nothing has out"
        hint="Rennet checks it out here: the repository's path, escaped, then the branch as path segments"
      >
        <Shape>~/.rennet/worktrees/&lt;repo&gt;/&lt;branch&gt;</Shape>
      </Row>
      <Row
        label="A pull request"
        hint="a detached checkout at the reviewed commit, re-pinned in place when that commit moves"
      >
        <Shape>~/.rennet/worktrees/&lt;owner&gt;/&lt;repo&gt;/pr-&lt;number&gt;</Shape>
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
