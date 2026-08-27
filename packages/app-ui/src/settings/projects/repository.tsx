import type { ResolvedProvenance } from "@rennet/protocol";
import { Monitor, Server } from "lucide-react";
import { Icon } from "../../components/icon";
import type { SidebarHost, SidebarProject } from "../../shell/sidebar-data";
import { Row, Section, Segmented } from "../atoms";
import { toProvenance, useSetRepoVisibility, useSettingsView } from "../data";
import { ProvenanceChip } from "../provenance-chip";

// ─────────────────────────────────────────────────────────────────────────────
// The Projects → Repository section (C10 §8.4, claims 656–658). The ONE part of the
// page on a LIVE command: Review Context (local vs git-visible) reads and writes the
// real `settings.setRepoVisibility` (salvaged), with its resolver provenance chip;
// the promotion state is shown; and "Runs on" is a DISPLAYED DETECTED FACT — a
// provenance chip, a host glyph, and the host name, with NO editable override on the
// surface (reconciliation 7, R22 amendment — B10 made locus detection-only).
//
// The repo row (visibility + promotion + locus, each with the layer it resolved from)
// comes from `settings.get`, matched to the scoped project by id. The control writes
// through the row's `repoPath` — its stable address on the settings ladder.
// ─────────────────────────────────────────────────────────────────────────────

const VISIBILITY_OPTIONS = [
  { id: "local", label: "local" },
  { id: "git-visible", label: "git-visible" },
] as const;

export function RepositorySection({
  project,
  host,
}: {
  readonly project: SidebarProject;
  readonly host: SidebarHost;
}) {
  const { data } = useSettingsView();
  const setVisibility = useSetRepoVisibility();
  // A single-repo project contributes one row; take the first row for this project.
  const row = data?.projects.find((p) => p.projectId === project.id);

  // "Runs on" is where this project's commands run — the environment it lives on.
  // A detected fact: the row's locus provenance when known, else a detected chip of
  // the host itself (never invented as a chosen override).
  const locusProvenance: ResolvedProvenance =
    row?.locusProvenance ?? toProvenance({ value: host.label, layer: "detected" });

  return (
    <Section title="Repository" caption={`.rennet/ in ${project.name}`}>
      <Row label="Review Context" hint="whether .rennet is visible to git">
        {row ? (
          <>
            <ProvenanceChip provenance={row.visibilityProvenance} />
            <Segmented
              ariaLabel="Review context"
              options={VISIBILITY_OPTIONS}
              value={row.visibility}
              onChange={(visibility) =>
                setVisibility.mutate({
                  commandId: crypto.randomUUID(),
                  projectId: row.projectId,
                  repoPath: row.repoPath,
                  visibility,
                })
              }
            />
          </>
        ) : (
          <span className="text-xs text-ink-soft">not yet scanned</span>
        )}
      </Row>
      <Row label="Promotion" hint="review context committed and shared via the repo">
        {row ? <ProvenanceChip provenance={row.promotedProvenance} /> : null}
        <span className="text-xs text-ink-soft">{row?.promoted ? "promoted" : "not promoted"}</span>
      </Row>
      <Row label="Runs on" hint="where this project's commands run">
        {/* Detection only — no override control on the surface (reconciliation 7). */}
        <ProvenanceChip provenance={locusProvenance} />
        <span className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink">
          <Icon icon={host.kind === "local" ? Monitor : Server} className="size-3 text-ink-soft" />
          {host.label}
        </span>
      </Row>
    </Section>
  );
}
