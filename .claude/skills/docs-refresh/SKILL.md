---
name: docs-refresh
description: Use after a Rennet docs audit finds stale facts, broken navigation, missing current coverage, or untracked future claims.
---

# Docs refresh

Turn a fresh docs-audit report into a reviewed pull request.

## Steps

1. Run `docs-audit` when there is no current findings list.
2. Resolve conflicts in the report against code, tests, promoted specs, and live
   tracking. Write one verified statement for each disputed fact.
3. Create a worktree branch named `docs/refresh-<YYYY-MM-DD>`.
4. Give parallel agents disjoint file sets. Each assignment includes the
   verified fact, the finding, and the style rules from
   `docs/developing/contributing/docs-style-guide.md`.
5. Rewrite the full affected file where needed. Keep reader pages limited to
   current behavior and tracked plans. Keep authority edits within the owner's
   declared scope.
6. Review the complete diff against the findings and remove unsupported edits.
7. Run the documentation project tests and build through Nx. Then run
   `pnpm nx affected -t lint,typecheck,test,build` and the full `pnpm check`
   gate, one Nx invocation at a time.
8. Commit, push, open a pull request, and resolve its independent reviews before
   merge.

The refresh is complete when every finding is fixed or the pull request records
a concrete reason for leaving it. A reader must not come away with a false claim
about current or planned Rennet.

No refresh may add a consent gate, confirmation ceremony, capability
restriction, or robustness work detached from Rennet's job.
