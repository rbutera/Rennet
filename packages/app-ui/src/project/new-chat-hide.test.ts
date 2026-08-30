// #580's mirror on the HIDE side (#587). `claimingSession` made the host resolve a round to
// the right repo's session; `hideClaimedRows` still decided with `claimMatchesTarget` alone,
// which knows only branch-or-PR-number. So claiming `main` in repo-a hid repo-b's `main` row
// — a row the reviewer could no longer click, for a repository they never started a session
// in. That is the worse half to leave: the ledger now resolves correctly to a session whose
// row has vanished.
//
// The rule is #580's silence rule, verbatim (`session-entry.ts`): exclude only on a POSITIVE
// contradiction, never on either side's absence. Both directions are controlled below,
// because each failure mode is reachable and they pull opposite ways — hiding too little
// re-offers a row that already has a session (a click then mints a SECOND session for one
// target), and hiding too much is the bug this closes.
import { describe, expect, it } from "vitest";
import { hideClaimedRows, type MintTarget } from "./new-chat-mint";
import type { SmartRow } from "./smart-list";

const GITHUB_WIDGET = { forge: "github", owner: "acme", name: "widget" } as const;
const GITLAB_WIDGET = { forge: "gitlab", owner: "acme", name: "widget" } as const;

/** A local-work row in `repository`, on `branch`. */
function localRow(
  repository: string,
  branch: string,
  forgeRepository?: { readonly forge: string; readonly owner: string; readonly name: string },
): SmartRow {
  return {
    kind: "local",
    id: `${forgeRepository?.forge ?? "legacy"}:${repository}\n${branch}`,
    branch,
    title: branch,
    author: "me",
    mine: true,
    local: {
      repository,
      branch,
      dirty: false,
      ...(forgeRepository === undefined ? {} : { forgeRepository }),
    },
  } as unknown as SmartRow;
}

const survivors = (rows: readonly SmartRow[], claimed: readonly MintTarget[]) =>
  hideClaimedRows(rows, claimed).map((row) => `${row.local?.repository}:${row.branch}`);

describe("hideClaimedRows keeps the hide repo-precise (#580 mirror)", () => {
  const rows = [localRow("acme/alpha", "main"), localRow("acme/beta", "main")];

  it("hides ONLY the claimed repository's row when two repos share a branch name", () => {
    // The bug: both rows vanished, and `acme/beta`'s `main` became unclickable.
    expect(survivors(rows, [{ branch: "main", repository: "acme/alpha" }])).toEqual([
      "acme/beta:main",
    ]);
  });

  it("CONTROL, hiding too much: dropping the repository comparison hides both rows", () => {
    // The pre-fix behaviour, reproduced by claiming with no repository named. It is also the
    // silence rule's first arm — a claim that names no repo contradicts nothing, so it still
    // owns every row it matches on branch.
    expect(survivors(rows, [{ branch: "main" }])).toEqual([]);
  });

  it("CONTROL, hiding too little: an unstamped claim still hides its row", () => {
    // Over-tightening is the worse failure. A session minted before the row carried a
    // repository has none; requiring equality would re-offer its row, and the click would
    // mint a SECOND session for a target that already has one.
    expect(survivors([localRow("acme/alpha", "feat/x")], [{ branch: "feat/x" }])).toEqual([]);
  });

  it("CONTROL, hiding too little: a row with no repository is still hidden by a stamped claim", () => {
    // The silence rule's other absent side. Neither half may harden into a mismatch.
    const bare = { kind: "local", id: "feat/y", branch: "feat/y" } as unknown as SmartRow;
    expect(hideClaimedRows([bare], [{ branch: "feat/y", repository: "acme/alpha" }])).toEqual([]);
  });

  it("a PR claim still owns its branch row in the SAME repo, and not another's", () => {
    // A branch and its PR are one claimed thing (#466 res. 11) — repo-precision must not
    // break that, only scope it.
    const claimed: MintTarget[] = [{ branch: "main", prNumber: 7, repository: "acme/alpha" }];
    expect(survivors(rows, claimed)).toEqual(["acme/beta:main"]);
  });

  it("keeps the same owner/name, branch, and PR number distinct across forges", () => {
    const forgeRows = [
      localRow("acme/widget", "main", GITHUB_WIDGET),
      localRow("acme/widget", "main", GITLAB_WIDGET),
    ];

    const remaining = hideClaimedRows(forgeRows, [
      {
        branch: "main",
        prNumber: 7,
        repository: "acme/widget",
        forgeRepository: GITHUB_WIDGET,
      },
    ]);
    expect(remaining.map((row) => row.id)).toEqual(["gitlab:acme/widget\nmain"]);

    // A persisted pre-field session has no structured identity. Keep the legacy
    // owner/name rule rather than re-offering a target whose session already exists.
    expect(
      hideClaimedRows(forgeRows, [{ branch: "main", prNumber: 7, repository: "acme/widget" }]),
    ).toEqual([]);
  });
});
