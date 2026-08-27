import type { ResolvedProvenance } from "@rennet/protocol";
import { cn } from "@rennet/ui";

// ─────────────────────────────────────────────────────────────────────────────
// ProvenanceChip (C10 §1.3, claim 579) — the ONE shared chip every layered value
// reuses to name the rung it resolved from. It renders the resolver's OWN answer
// (`ResolvedProvenance`), never a recomputed account that could disagree with the
// engine: the effective `layer` as the summary chip, and the lowest-first list of
// contributing layers with the effective one flagged. Salvaged verbatim in spirit
// from the deleted `components/settings-screen.tsx` `Provenance`, which bound the
// same live shape — only the summary label is made rung-literal (builtin / detected
// / global / repo) per the claim, instead of the old set-here/default wording.
// ─────────────────────────────────────────────────────────────────────────────

/** The four ladder rungs, lowest→highest (mirrors `settingsLayerSchema`). */
export const LAYER_LABEL: Record<ResolvedProvenance["layer"], string> = {
  builtin: "builtin",
  detected: "detected",
  global: "global",
  repo: "repo",
};

export function ProvenanceChip({ provenance }: { readonly provenance: ResolvedProvenance }) {
  // A value is "set" (a user/repo choice) at the global or repo rung; builtin and
  // detected are the machine's own answer. The distinction only drives the accent.
  const chosen = provenance.layer === "global" || provenance.layer === "repo";
  return (
    <span
      data-slot="provenance-chip"
      data-layer={provenance.layer}
      className="inline-flex flex-wrap items-center gap-1.5"
    >
      <span
        className={cn(
          "rounded-chip border px-2 py-0.5 text-2xs uppercase tracking-wide",
          chosen ? "border-line-strong bg-raised text-ink" : "border-line text-ink-faint",
        )}
      >
        {LAYER_LABEL[provenance.layer]}
      </span>
      <span className="inline-flex flex-wrap gap-1">
        {provenance.contributions.map((c) => (
          <span
            key={c.layer}
            className={cn(
              "rounded-micro border px-1.5 py-0.5 text-2xs tracking-wide",
              c.effective
                ? "border-line-strong text-ink"
                : "border-dashed border-line text-ink-faint",
            )}
          >
            {`${c.layer}: ${c.value}`}
          </span>
        ))}
      </span>
    </span>
  );
}
