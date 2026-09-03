// @rennet/t3-chat: the rung-two native ChatView mount, lazy so the vendored web app is
// a separate renderer chunk that only a project on the `t3` engine ever downloads.
// Public types live in ./public.d.ts (the package's `types` export): consumers typecheck
// against that surface and never traverse the vendored source. Nothing else is exported:
// the session helpers import @t3tools/contracts (Effect Schema), and re-exporting them
// here put ~500 KB of it into the renderer's STARTUP chunk for every project.

import { lazy } from "react";

export const T3NativeChat = lazy(() => import("./native-chat"));
// Both views live in the one module so they share a chunk (and the vendored ChatView it
// pulls in); the thread view is a named export, so it needs the default-shape adapter.
export const T3ThreadView = lazy(() =>
  import("./native-chat").then((module) => ({ default: module.T3ThreadView })),
);
export type { T3NativeChatProps, T3ThreadViewProps } from "./native-chat";
