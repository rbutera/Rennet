// A command id for invocations that need one (issue #383 M1). The recipe lives in
// `@rennet/protocol` next to `commandIdSchema`, which is `z.uuid()` — the local
// `cmd-${Date.now()}-${random}` fallback this used to carry produced ids the daemon
// silently refuses, which is strictly worse than throwing. `src/polyfills.ts` installs a
// real v4 `crypto.randomUUID` at app entry, so Hermes has the API before any route mounts.
export { newCommandId } from "@rennet/protocol";
