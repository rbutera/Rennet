// Rennet's own copy inside the native T3 mount — the paragraphs a reviewer reads when the
// router is somewhere other than a live thread. They live apart from `native-chat.tsx`
// because that file imports the vendored web app through the `~/` alias, which only the
// desktop Vite configs define: this file imports nothing but React, so the words can be
// rendered and read back by a test in this package.
//
// #849 made every state here a WAIT rather than a bare absence. #872 is the correction to
// that: a wait is only honest while something really is happening, and the mount had one
// state — the router bounced home off a thread the snapshot had not delivered — where the
// wait never ended and the sentence stayed on screen for the life of the session. So the
// rule is not "always say a wait". It is: SAY WHICH ONE IT IS. Two of these are waits with
// something on the other end; two state an absence that is settled, and say why.

/**
 * The router's home path. Reached only when the mount has NO thread: the daemon was asked
 * to bind one for this review and could not, and said so on the wire
 * (`t3ThreadBindingSchema`'s `unavailable` arm).
 *
 * It used to be reachable a second way — the thread route redirecting here when the
 * environment snapshot lagged the thread the daemon had just created — and that is why the
 * copy promised an opening thread. That redirect is gone (`resolvePinnedThreadView`), so
 * this route means one thing again and can say it flatly.
 */
export function ThreadUnavailableNotice({ reason }: { readonly reason?: string }) {
  return (
    <p data-slot="t3-native-home" className="p-3 text-xs text-muted-foreground">
      This review has no thread, and none is being opened.
      {reason === undefined ? "" : ` Rennet could not open one: ${reason}`}
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

/**
 * The thread was bound, and the sidecar now reports it DELETED — a positive contradiction,
 * not the snapshot being behind. Without this arm the mount would wait on `ThreadSyncingNotice`
 * for something that is never coming, which is the defect #872 was filed about.
 */
export function ThreadGoneNotice() {
  return (
    <p data-slot="t3-native-gone" className="p-3 text-xs text-muted-foreground">
      This review's thread is no longer in the T3 Code sidecar. Nothing is being written to it.
    </p>
  );
}
