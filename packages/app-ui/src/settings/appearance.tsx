import type { AppearanceScheme } from "@rennet/protocol";
import { CODE_THEMES } from "./assets/code-theme";
import { THEME_PACKS } from "./assets/theme-packs";
import { PillChoice, Row, Section, Segmented } from "./atoms";
import { useSetAppearance, useSettingsView } from "./data";
import { ProvenanceChip } from "./provenance-chip";
import { useThemePref } from "./theme-pref";

// ─────────────────────────────────────────────────────────────────────────────
// Appearance page (C10 §6). Scheme is the one appearance value with a LIVE command
// today (`settings.setAppearance`, salvaged from the deleted settings-screen and
// rewritten onto the data seam — `useCommand`/`useMutation`, never `bridge.invoke`).
// "system" resolves through `matchMedia` app-wide in `routes/app.tsx`'s
// `AppearanceSync`; this page only writes the choice, which that synchronizer then
// stamps on the document root.
//
// Theme Pack + Code Theme (claims 631–634) are CLIENT prefs with no protocol command
// (B10-absent). They read/write the app-global `useThemePref` — genuine live state
// that stamps `data-rn-theme` / `data-rn-code-theme` on the root — NOT the honest-empty
// `SettingsProjection` (which would make the pickers inert in the live client). Both are
// live-applying pill rows; the code theme is INDEPENDENT of the pack (any pack runs with
// any code theme), and "Follow theme" (the default `rennet`) resolves code to the active
// pack's own syntax, which itself swaps with the scheme. Changing the code theme
// recolours every code surface incl. the diff with no JS — the `.rtok-*` spans read
// `--rn-syn-*`, and the code-theme CSS rebinds those under `[data-rn-code-theme]`.
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
    <>
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

      <ThemePackSection />
      <CodeThemeSection />
    </>
  );
}

/** The UI theme pack — a live-applying pill row (claims 631–634). The pack re-binds
 *  every --rn-* token app-wide the moment it stamps `data-rn-theme` on the root. */
function ThemePackSection() {
  const { themePack, setThemePack } = useThemePref();
  return (
    <Section title="Theme Pack" caption="~/.rennet/config.json">
      <Row label="Theme" hint="the interface palette" stacked>
        <PillChoice
          ariaLabel="Theme pack"
          options={THEME_PACKS}
          value={themePack}
          onChange={setThemePack}
        />
      </Row>
    </Section>
  );
}

/** The code theme — an INDEPENDENT live-applying pill row (claim 632). Stamping
 *  `data-rn-code-theme` recolours every code surface incl. the diff with no JS. */
function CodeThemeSection() {
  const { codeTheme, setCodeTheme } = useThemePref();
  return (
    <Section title="Code Theme" caption="~/.rennet/config.json">
      <Row label="Theme" hint="syntax highlighting in code and diffs" stacked>
        <PillChoice
          ariaLabel="Code theme"
          options={CODE_THEMES}
          value={codeTheme}
          onChange={setCodeTheme}
        />
      </Row>
    </Section>
  );
}
