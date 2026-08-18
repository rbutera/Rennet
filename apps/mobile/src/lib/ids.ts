// A command id for invocations that need one (issue #383 M1). Prefers the platform's
// crypto.randomUUID (present via the app's random-values polyfill), with a plain fallback so
// a build without it still produces a unique, correlatable id rather than throwing.
export function newCommandId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
