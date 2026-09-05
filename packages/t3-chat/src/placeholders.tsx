// Rennet's own copy inside the native T3 mount — the paragraphs a reviewer reads when the
// router is somewhere other than a live thread. They live apart from `native-chat.tsx`
// because that file imports the vendored web app through the `~/` alias, which only the
// desktop Vite configs define: this file imports nothing but React, so the words can be
// rendered and read back by a test in this package.
//
// Every state here is a WAIT, not an absence (#849). The states where nothing is coming
// belong to the dock around this mount (`@rennet/app-ui`'s `t3-chat-dock.tsx`): a sidecar
// that could not be brought up, and a host that mounts no chat view at all.

/**
 * The router's home path: the session was brokered before its thread id existed, or the
 * thread route bounced here because the environment snapshot does not carry the thread the
 * daemon just made.
 *
 * This used to read "No thread is bound to this review yet." — true, and a dead end. It
 * named an absence and told the reviewer nothing about what was happening or what to
 * expect, so the dock looked broken at the first moment they saw it. Since #849 the review
 * binds its thread when it is captured, so this is a brief pass-through rather than a
 * resting state; the copy says which.
 */
export function ThreadOpeningNotice() {
  return (
    <p data-slot="t3-native-home" className="p-3 text-xs text-muted-foreground">
      Opening this review's thread. It appears here as soon as the T3 Code sidecar has it.
    </p>
  );
}

/** The connections route ChatView can navigate to. The daemon owns this environment. */
export function ConnectionsNotice() {
  return (
    <p data-slot="t3-native-settings" className="p-3 text-xs text-muted-foreground">
      Connections are managed by the Rennet daemon; there is nothing to configure here.
    </p>
  );
}

/** A thread that exists but whose detail has not arrived over the sidecar socket yet. */
export function ThreadSyncingNotice() {
  return (
    <p data-slot="t3-native-syncing" className="p-3 text-xs text-muted-foreground">
      Connecting to the T3 Code sidecar…
    </p>
  );
}
