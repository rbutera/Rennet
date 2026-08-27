import { Button } from "@rennet/ui";
import { Plus } from "lucide-react";
import { useMemo } from "react";
import { Icon } from "../../components/icon";
import { useBridge } from "../../data";
import { useRennetStore } from "../../store";
import type { HostOS } from "../assets/os-glyphs";
import { Section } from "../atoms";
import { type SettingsHost, useSettingsProjection } from "../data";
import { HostCard } from "./host-card";

// ─────────────────────────────────────────────────────────────────────────────
// The Environments page (C10 §3, claims 583–584). "This Machine" as the local card
// (never removable), remote hosts as cards below it. The section header carries its
// OWN Add Environment button — the second entry point beside the sidebar's, sharing
// the same `add-environment` dialog flow.
//
// The remote hosts + their daemon detection are B10-absent, so they resolve through
// the projection (honest-empty in the live client until B10). The LOCAL machine is
// genuinely knowable NOW — its platform and the running app version come straight
// from the bridge — so an honest local card always shows even with no projection.
// A test supplies the full hosts list to drive remote-card scenarios.
// ─────────────────────────────────────────────────────────────────────────────

/** Map the bridge platform string to a host OS glyph (WSL is undetectable here). */
function osFromPlatform(platform: string | undefined): HostOS {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

export function EnvironmentsPage() {
  const projection = useSettingsProjection();
  const bridge = useBridge();
  const openDialog = useRennetStore((s) => s.uiActions.openDialog);

  // The projection owns the hosts when it carries any (tests, and B10 later). Until
  // then the live client shows the one host it can honestly resolve: the local machine.
  const hosts = useMemo<readonly SettingsHost[]>(() => {
    if (projection.hosts.length > 0) return projection.hosts;
    return [
      {
        id: "local",
        name: "This Machine",
        kind: "local",
        os: osFromPlatform(bridge.platform),
        daemon: { reachable: true, version: bridge.version },
      },
    ];
  }, [projection.hosts, bridge.platform, bridge.version]);

  return (
    <Section
      title="Environments"
      caption="~/.rennet/daemon-settings.json on each host"
      bare
      titleExtra={
        <Button
          variant="outline"
          size="xs"
          className="ml-2"
          onClick={() => openDialog("add-environment")}
        >
          <Icon icon={Plus} />
          Add Environment
        </Button>
      }
    >
      {hosts.map((host) => (
        <HostCard key={host.id} host={host} />
      ))}
    </Section>
  );
}
