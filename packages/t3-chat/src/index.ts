// @rennet/t3-chat: the rung-two native ChatView mount, lazy so the vendored web app is
// a separate renderer chunk that only a project on the `t3` engine ever downloads.
// Public types live in ./public.d.ts (the package's `types` export): consumers typecheck
// against that surface and never traverse the vendored source.

import { lazy } from "react";

export const T3NativeChat = lazy(() => import("./native-chat"));
export type { T3NativeChatProps } from "./native-chat";
export { sidecarRegistration, sidecarThreadPath, sidecarWsBaseUrl } from "./session";
