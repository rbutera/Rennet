import type { LensBoard } from "@rennet/protocol";
import { board, codeRef, decision, prose, section } from "./helpers";

const CHANGE = "openspec/changes/github-token-refresh-reliability";

// Decisions lens — the judgment calls inside the change, each with cited evidence.
export const decisionsBoard: LensBoard = board("decisions", "gen1", "decisions-gen1", [
  section(
    "secret-safe-observability",
    "Secret-Safe Observability",
    "What each refresh writes to daemon.log, and why no credential can land there.",
    [
      prose(
        "sso-intro",
        "Judgment calls that make the daemon's GitHub token refresh observable in daemon.log while keeping every record secret-free by construction.",
      ),
      decision("d-injected", {
        statement:
          "The refresh layer emits observations through an injected `log?` callback on `ResolveAuthDeps`; `create-server` binds the concrete sink that writes daemon.log.",
        why: "The adapter stays side-effect-free and testable, tests assert on captured records, and production formatting lives at the composition boundary. A bare console call would make the secret-safety guarantee untestable.",
        evidence: ["cr-log-dep", "cr-sink"],
        alternatives: ["A bare console.error inside the adapter (couples the adapter to a sink)"],
      }),
      decision("d-typed-record", {
        statement:
          "The log payload is a typed `RefreshLogRecord` carrying only `phase`, an optional `githubError`, and an optional `tokenKind`. No field can hold a token or secret.",
        why: "Secret-safety is a property of the type, not a promise made in review. With no token/refresh/secret field to write to, a credential cannot be logged by construction.",
        evidence: ["cr-record-type"],
        alternatives: [
          "A freeform log line or a record carrying the credential object",
          "A field holding a masked or length-tagged token (any secret-carrying field defeats the guarantee)",
        ],
      }),
      decision("d-allowlist", {
        statement:
          '`tokenKind` returns only a member of a closed prefix allowlist (`ghu_`, `gho_`, …) or the fixed `"token"`, never a substring of the token body.',
        why: "An earlier draft returned everything before the first underscore, so an unexpected value could log real credential bytes. The closed allowlist makes the label secret-safe by construction.",
        evidence: ["cr-prefixes", "cr-tokenkind"],
        alternatives: [
          "Return the substring before the first `_` (leaks a slice of an unexpected body)",
          "Emit no token-kind at all (loses the non-secret signal)",
        ],
      }),
    ],
    {
      refs: [
        codeRef("cr-log-dep", "packages/adapters/src/github-auth.ts", 97, 108),
        codeRef("cr-sink", "packages/server/src/create-server.ts", 616, 630),
        codeRef("cr-record-type", "packages/adapters/src/github-auth.ts", 53, 63),
        codeRef("cr-prefixes", "packages/adapters/src/github-auth.ts", 67, 80),
        codeRef("cr-tokenkind", "packages/adapters/src/github-auth.ts", 82, 90),
      ],
    },
  ),
  section(
    "retry-and-failure",
    "Retry Ownership and Failure Outcomes",
    "Who retries a transient blip, and what a genuine decline leaves behind.",
    [
      decision("d-no-retry", {
        statement:
          "`refreshAndPersist` adds no retry of its own. A network failure emits a `network` record and propagates, leaving retry to the shared connect-phase transport.",
        why: "The shared transport already retries a connect-phase blip once, replay-safely, and never replays a post-send failure. A second retry here would be redundant and less safe — `isGitHubNetworkError` also matches post-send errors that may have already rotated the pair.",
        evidence: ["cr-catch", "cr-design-3"],
        alternatives: [
          "Retry inside `refreshAndPersist` on `isGitHubNetworkError` (risks burning a rotated token)",
        ],
      }),
      decision("d-decline-keeps", {
        statement:
          "A declined refresh returns null (surfacing `token-invalid`) but leaves the stored credential file untouched. Clearing it on a persistent decline is deferred.",
        why: "The change leaves persistence and classification unchanged to keep it small. The new log makes the dead-refresh loop visible, so revisit only if the field shows churn.",
        evidence: ["cr-declined", "cr-open-q"],
        alternatives: ["Clear the credential on a persistent decline (deferred open question)"],
      }),
    ],
    {
      refs: [
        codeRef("cr-catch", "packages/adapters/src/github-auth.ts", 246, 276),
        codeRef("cr-design-3", `${CHANGE}/design.md`, 27),
        codeRef("cr-declined", "packages/adapters/src/github-auth.ts", 248, 253),
        codeRef("cr-open-q", `${CHANGE}/design.md`, 41, 43),
      ],
    },
  ),
]);
