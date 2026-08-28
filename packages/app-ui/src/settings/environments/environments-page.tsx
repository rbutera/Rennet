import { Button } from "@rennet/ui";
import { Plus } from "lucide-react";
import { useMemo } from "react";
import { Icon } from "../../components/icon";
import { useBridge } from "../../data";
import { useRennetStore } from "../../store";
import { osFromPlatform } from "../assets/os-glyphs";
import { Section } from "../atoms";
import { type SettingsHost, useSettingsProjection } from "../data";
import { HostCard } from "./host-card";

// ─────────────────────────────────────────────────────────────────────────────
// The Environments page (C10 §3, claims 583–584). "This Machine" as the local card
// (never removable), remote hosts as cards below it. The section header carries its
// OWN Add Environment button — the second entry point beside the sidebar's, sharing
// the same `add-environment` dialog flow.
//
// Every host — this machine and each paired one — comes from the projection, which
// C17 binds to the real per-host detection (`settings.get.daemonHosts` enumerated,
// `daemon.status` probed, `forge.detect` / `harness.hosts` folded per host). The
// bridge-synthesised local card below is the fallback for the ZERO-projection case
// only: before the reads resolve, or when they fail, the one host still honestly
// knowable is this machine (its platform and running app version come straight from
// the bridge). A test supplies the full hosts list to drive remote-card scenarios.
// ─────────────────────────────────────────────────────────────────────────────

export function EnvironmentsPage() {
  const projection = useSettingsProjection();
  const bridge = useBridge();
  const openDialog = useRennetStore((s) => s.uiActions.openDialog);

  // The projection owns the hosts whenever it carries any. Until its reads resolve
  // the client shows the one host it can honestly resolve: the local machine.
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
