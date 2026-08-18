// Pair a daemon (issue #383 M1, wireframe 19). Scan the desk-minted QR (a pairing link) or
// paste it, exchange the one-time code for a device token, and land on the connections list.
// Pairing is bootstrap, not a consent gate (Rule Zero): after one success the daemon just works.

import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { OutlineButton, PrimaryButton, Screen } from "../src/components/ui";
import { parsePairingLink } from "../src/lib/deep-links";
import { useRuntime } from "../src/runtime/context";
import { radii, space, type } from "../src/theme/tokens";
import { useTheme } from "../src/theme/use-theme";

export default function Pair(): ReactNode {
  const t = useTheme();
  const router = useRouter();
  const runtime = useRuntime();
  const [permission, requestPermission] = useCameraPermissions();
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);

  async function pair(rawLink: string): Promise<void> {
    const offer = parsePairingLink(rawLink);
    if (!offer) {
      setError("That is not a Rennet pairing link.");
      return;
    }
    setError(null);
    setPairing(true);
    try {
      await runtime.pairDaemon({ url: offer.url, code: offer.code, name: offer.name });
      router.replace("/connections");
    } catch {
      setError("Pairing failed — the code may be expired. Mint a fresh one on your desktop.");
    } finally {
      setPairing(false);
    }
  }

  return (
    <Screen>
      <View
        style={{
          height: 300,
          borderRadius: radii.xl,
          overflow: "hidden",
          backgroundColor: t.ink,
          justifyContent: "center",
        }}
      >
        {permission?.granted ? (
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={pairing ? undefined : ({ data }) => void pair(data)}
          />
        ) : (
          <View style={{ padding: space.xl, alignItems: "center" }}>
            <Text style={{ color: t.canvas, textAlign: "center", marginBottom: space.md }}>
              Point at the QR on your desktop — Settings → Devices → Pair
            </Text>
            <OutlineButton label="Enable camera" onPress={() => void requestPermission()} />
          </View>
        )}
      </View>

      <Text
        style={{ color: t.faint, fontSize: type.pill, letterSpacing: 1.2, marginTop: space.xl }}
      >
        OR PASTE THE PAIRING LINK
      </Text>
      <TextInput
        value={link}
        onChangeText={setLink}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="rennet://pair?url=…&code=…"
        placeholderTextColor={t.faint}
        style={{
          borderWidth: 1,
          borderColor: t.line2,
          borderRadius: radii.md,
          padding: space.md,
          marginTop: space.sm,
          color: t.text,
          backgroundColor: t.card,
        }}
      />
      {error && <Text style={{ color: t.amber, marginTop: space.sm }}>{error}</Text>}
      <PrimaryButton label={pairing ? "Pairing…" : "Pair"} onPress={() => void pair(link)} />
    </Screen>
  );
}
