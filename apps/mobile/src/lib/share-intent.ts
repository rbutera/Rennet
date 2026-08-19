// Share-intent extraction (issue #382 M2 finding 9, task 5.2). When the OS hands the app a shared
// PR link (Android `Intent.EXTRA_TEXT`, read by expo-share-intent's native module), this pure
// helper picks the URL to pre-fill the kickoff PR field. Kept framework-free so it unit-tests; the
// RN/Expo glue (the `useShareIntent` hook + routing) lives in the runtime.
//
// Extraction is deliberately permissive: prefer the module's parsed `webUrl`, else fall back to the
// raw shared `text` (a share sheet often hands the whole message, e.g. "Look at this PR <url>").
// kickoff's `parsePrRef` then scans that text for a PR ref and rejects anything that is not one, so
// this only has to surface "the shared string", never validate it.

/** The slice of expo-share-intent's `ShareIntent` this reads (both fields nullable). */
export interface SharedContent {
  readonly webUrl?: string | null;
  readonly text?: string | null;
}

/**
 * The shared string to hand kickoff's `?url=` param: the parsed web URL if present, else the raw
 * shared text, else null (nothing shareable — the screen stays on its own empty state). Trimmed.
 */
export function sharedUrlFromIntent(intent: SharedContent): string | null {
  const url = intent.webUrl?.trim();
  if (url) return url;
  const text = intent.text?.trim();
  return text ? text : null;
}
