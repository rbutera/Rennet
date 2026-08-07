import type { SsoState } from "@rennet/core";

/**
 * Parse the `X-GitHub-SSO` response header into a forge-neutral `SsoState`.
 *
 * The header, when present, is a directive (`required` or `partial-results`)
 * followed by `;`-separated `key=value` params: `organizations=<comma ids>` and
 * `url=<authorization url>`. `partial-results` is the dangerous case — a 200 with
 * a valid-looking payload that is actually INCOMPLETE because the token is not
 * authorized across some organizations — so it is lifted to a first-class state
 * carrying the org ids and the (1-hour) authorization URL. Anything unrecognized,
 * absent, or empty is `none` (fail toward "no SSO constraint observed", which the
 * caller treats as a complete result; a genuine constraint always names itself).
 */
export function parseGitHubSso(headerValue: string | null | undefined): SsoState {
  if (!headerValue) return { kind: "none" };
  const segments = headerValue
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const directive = segments[0]?.toLowerCase();
  if (directive !== "required" && directive !== "partial-results") return { kind: "none" };

  let organizations: string[] = [];
  let authorizationUrl: string | null = null;
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    const value = segment.slice(eq + 1).trim();
    if (key === "organizations") {
      organizations = value
        .split(",")
        .map((org) => org.trim())
        .filter((org) => org.length > 0);
    } else if (key === "url") {
      authorizationUrl = value.length > 0 ? value : null;
    }
  }

  return { kind: directive, organizations, authorizationUrl };
}
