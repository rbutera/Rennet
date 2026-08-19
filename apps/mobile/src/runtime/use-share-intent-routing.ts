// Share-sheet routing (issue #382 M2 finding 9, task 5.2). When the user shares a PR link into
// Rennet (Android `Intent.EXTRA_TEXT`, read natively by expo-share-intent), land on the kickoff
// screen with the shared URL pre-filled. iOS is disabled at the plugin (no share extension this
// pass — the recorded follow-up); there the paste + `rennet://kickoff` paths carry a shared link.
//
// The RN/Expo glue only: the URL extraction is the pure `sharedUrlFromIntent` (unit-tested), and
// kickoff's `parsePrRef` validates the result — this hook just moves a shared string to the route.

import { useRouter } from "expo-router";
import { useShareIntent } from "expo-share-intent";
import { useEffect } from "react";
import { sharedUrlFromIntent } from "../lib/share-intent";

/** Route a shared PR link to `/kickoff?url=…` once the native share intent is ready. Mount at root. */
export function useShareIntentRouting(): void {
  const router = useRouter();
  // resetOnBackground:false so a foreground/background bounce does not drop an unrouted share.
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({
    resetOnBackground: false,
  });

  useEffect(() => {
    if (!hasShareIntent) return;
    const url = sharedUrlFromIntent(shareIntent);
    resetShareIntent();
    if (url) router.push({ pathname: "/kickoff", params: { url } });
  }, [hasShareIntent, shareIntent, resetShareIntent, router]);
}
