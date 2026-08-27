import { cn } from "@rennet/ui";
import { GitHubIcon } from "../../components/brand-mark";

// ─────────────────────────────────────────────────────────────────────────────
// Source-control tool marks (C10 §4.3, claims 604–607). The forge marks Rennet
// rides: git itself, GitHub (`gh`), GitLab (`glab`), and Bitbucket (API token).
// Azure DevOps deliberately does NOT appear.
//
// git / GitLab / Bitbucket are simple-icons path data (CC0), rendered monochrome
// with `currentColor` so each reads on both schemes — the same nominative-use,
// inline-glyph precedent as `os-glyphs.tsx`. GitHub reuses the committed octocat
// (`GitHubIcon`), also `currentColor`, which is exactly the scheme-swap the claim
// asks for (black on light, paper on dark — it follows the text ink). No coloured
// brand fills, no OAuth-shaped connect ceremony anywhere (Rule Zero, #483).
// ─────────────────────────────────────────────────────────────────────────────

export type SourceControlToolId = "git" | "gh" | "glab" | "bitbucket";

const MARK_PATHS: Record<Exclude<SourceControlToolId, "gh">, string> = {
  git: "M13.09 23.549a1.54 1.54 0 0 1-2.18 0L.451 13.089a1.54 1.54 0 0 1 0-2.179l7.191-7.19 2.733 2.733a1.85 1.85 0 0 0 .964 2.326v6.66a1.849 1.849 0 1 0 1.54 0V8.957l2.508 2.508a1.85 1.85 0 1 0 1.09-1.09l-2.634-2.634a1.85 1.85 0 0 0-2.378-2.377L8.73 2.63 10.91.451a1.54 1.54 0 0 1 2.179 0l10.459 10.46a1.54 1.54 0 0 1 0 2.179z",
  glab: "m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z",
  bitbucket:
    "M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z",
};

const MARK_LABEL: Record<SourceControlToolId, string> = {
  git: "Git",
  gh: "GitHub",
  glab: "GitLab",
  bitbucket: "Bitbucket",
};

/** The official mark for one source-control tool — monochrome, `currentColor`. */
export function ToolMark({
  id,
  className,
}: {
  readonly id: SourceControlToolId;
  readonly className?: string;
}) {
  if (id === "gh") return <GitHubIcon className={cn("size-4", className)} />;
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label={MARK_LABEL[id]}
      className={cn("size-4 fill-current", className)}
    >
      <path d={MARK_PATHS[id]} />
    </svg>
  );
}
