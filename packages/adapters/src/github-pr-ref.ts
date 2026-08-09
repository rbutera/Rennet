import type { ForgePullRequestRef } from "@rennet/core";

/**
 * Parse a human-typed pull-request reference into a forge-neutral ref — the
 * front door's address bar. Accepts the two shapes a user actually types:
 *
 *   - shorthand: `owner/repo#123` (whitespace around the `#` is tolerated)
 *   - a GitHub PR URL: `https://github.com/owner/repo/pull/123` (extra trailing
 *     path segments like `/files`, and any `?query`/`#hash`, are ignored)
 *
 * Returns `null` for anything it cannot confidently read, so the caller shows a
 * clear "that does not look like a pull request" message rather than guessing a
 * wrong repo/number. GitHub-only in this slice (`forge` is fixed `"github"`);
 * another forge is a later parser behind the same return shape.
 */
export function parseGitHubPrRef(input: string): ForgePullRequestRef | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // URL form: <scheme>://github.com/owner/repo/pull/<number>(/...)(?...)(#...)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const pullIndex = parts.indexOf("pull");
    // Need `owner`, `repo` before `pull`, and a number after it.
    if (pullIndex < 2) return null;
    return build(parts[pullIndex - 2], parts[pullIndex - 1], parts[pullIndex + 1]);
  }

  // Shorthand form: owner/repo#123 (spaces around the `#` tolerated).
  const match = /^([^\s/]+)\/([^\s#]+?)\s*#\s*(\d+)$/.exec(trimmed);
  if (!match) return null;
  return build(match[1], match[2], match[3]);
}

/** Assemble a ref from raw parts, validating the number and stripping a `.git` suffix. */
function build(
  owner: string | undefined,
  name: string | undefined,
  rawNumber: string | undefined,
): ForgePullRequestRef | null {
  if (!owner || !name || rawNumber === undefined) return null;
  const number = Number(rawNumber);
  if (!Number.isInteger(number) || number <= 0) return null;
  const cleanName = name.replace(/\.git$/, "");
  if (cleanName.length === 0) return null;
  return { repo: { forge: "github", owner, name: cleanName }, number };
}
