import type { AppearanceScheme } from "@rennet/protocol";
import { Button } from "@rennet/ui";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { Icon } from "../components/icon";
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
// The live store is `~/.rennet/client-settings.json` (the B10 split landed; a legacy
// `config.json` is migrated FROM at daemon boot, `create-server.ts`). "system"
// resolves through `matchMedia` app-wide in `routes/app.tsx`'s `AppearanceSync`; this
// page writes the choice, which that synchronizer then stamps on the document root.
//
// A scheme resolved from the GLOBAL rung can be RESET to the builtin (`scheme: null`
// clears the entry so it falls back to `system`), restoring the control the port
// dropped. The write is awaited and its failure disclosed — a rejected write never
// silently no-ops. A malformed client-settings.json makes the write REFUSE (Rule 75):
// the control shows the builtin default and disables, so an edit never overwrites bytes
// we could not parse; a live-READ failure is shown as its own state, not a false System.
//
// Theme Pack + Code Theme (claims 631–634) are CLIENT prefs with NO backing file yet
// (session-only; cross-session persistence is the B10 fold). They read/write the
// app-global `useThemePref` — genuine live state that stamps `data-rn-theme` /
// `data-rn-code-theme` on the root — NOT the honest-empty `SettingsProjection`. Both are
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

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function AppearancePage() {
  const { data, pending: loading, error: readError } = useSettingsView();
  const { mutate, pending: writing } = useSetAppearance();
  const [writeError, setWriteError] = useState<string>();

  const scheme = data?.scheme ?? "system";
  const malformed = data?.appearanceMalformed ?? false;
  // An explicit global override can be reset to the builtin (system) default.
  const isGlobal = data?.schemeProvenance?.layer === "global";

  async function choose(next: AppearanceScheme) {
    if (writing || malformed || next === scheme) return;
    setWriteError(undefined);
    try {
      await mutate({ scheme: next });
    } catch (reason) {
      setWriteError(errorText(reason));
    }
  }

  async function resetToBuiltin() {
    if (writing || malformed) return;
    setWriteError(undefined);
    try {
      // `scheme: null` clears the global entry — the value falls back to the builtin.
      await mutate({ scheme: null });
    } catch (reason) {
      setWriteError(errorText(reason));
    }
  }

  return (
    <>
      <Section title="Appearance" caption="~/.rennet/client-settings.json">
        {loading ? (
          <Row label="Scheme" hint="light, dark, or follow the system">
            <span className="text-xs text-ink-soft">Loading…</span>
          </Row>
        ) : readError ? (
          <Row label="Scheme" hint="light, dark, or follow the system">
            <span className="text-xs text-accent">
              Couldn’t read settings: {errorText(readError)}
            </span>
          </Row>
        ) : (
          <>
            <Row label="Scheme" hint="light, dark, or follow the system">
              {data?.schemeProvenance ? (
                <ProvenanceChip provenance={data.schemeProvenance} />
              ) : null}
              {isGlobal && !malformed ? (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={writing}
                  aria-label="Reset appearance to the system default"
                  onClick={() => void resetToBuiltin()}
                >
                  <Icon icon={RotateCcw} className="size-3" />
                  Reset
                </Button>
              ) : null}
              <Segmented
                ariaLabel="Appearance scheme"
                options={SCHEMES}
                value={scheme}
                disabled={writing || malformed}
                onChange={(next) => void choose(next)}
              />
            </Row>
            {writeError ? (
              <div className="py-1 text-2xs text-accent" role="status">
                The write failed: {writeError}
              </div>
            ) : null}
            {malformed ? (
              <Row
                label=""
                hint="~/.rennet/client-settings.json is malformed — fix it to change the scheme"
              >
                <span className="text-2xs text-ink-faint">read-only</span>
              </Row>
            ) : null}
          </>
        )}
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
    <Section title="Theme Pack" sessionOnly>
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
    <Section title="Code Theme" sessionOnly>
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
