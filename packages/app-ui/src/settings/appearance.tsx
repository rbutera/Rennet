import type { AppearanceScheme } from "@rennet/protocol";
import { Row, Section, Segmented } from "./atoms";
import { useSetAppearance, useSettingsView } from "./data";
import { ProvenanceChip } from "./provenance-chip";

// ─────────────────────────────────────────────────────────────────────────────
// Appearance page (C10 §6). Scheme is the one appearance value with a LIVE command
// today (`settings.setAppearance`, salvaged from the deleted settings-screen and
// rewritten onto the data seam — `useCommand`/`useMutation`, never `bridge.invoke`).
// "system" resolves through `matchMedia` app-wide in `routes/app.tsx`'s
// `AppearanceSync`; this page only writes the choice, which that synchronizer then
// stamps on the document root.
//
// The Theme Pack and Code Theme rows (claims 631–634) land in the cluster-6 session:
// they carry no protocol command (B10-absent, client-side prefs) and need the
// app-global theme state + code-surface re-highlight wiring. Their absence here is
// honest — an unbuilt section, never a faked dead row.
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMES: readonly { readonly id: AppearanceScheme; readonly label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

export function AppearancePage() {
  const { data } = useSettingsView();
  const { mutate, pending } = useSetAppearance();

  const scheme = data?.scheme ?? "system";
  // A malformed `~/.rennet/config.json` makes the write REFUSE (Rule 75); the
  // control shows the builtin default and disables, so an edit never overwrites
  // bytes we could not parse.
  const malformed = data?.appearanceMalformed ?? false;

  function choose(next: AppearanceScheme) {
    if (pending || malformed || next === scheme) return;
    void mutate({ scheme: next });
  }

  return (
    <Section title="Appearance" caption="~/.rennet/config.json">
      <Row label="Scheme" hint="light, dark, or follow the system">
        {data?.schemeProvenance ? <ProvenanceChip provenance={data.schemeProvenance} /> : null}
        <Segmented
          ariaLabel="Appearance scheme"
          options={SCHEMES}
          value={scheme}
          onChange={choose}
        />
      </Row>
      {malformed ? (
        <Row label="" hint="~/.rennet/config.json is malformed — fix it to change the scheme">
          <span className="text-2xs text-ink-faint">read-only</span>
        </Row>
      ) : null}
    </Section>
  );
}
