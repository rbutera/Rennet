// The typed surface of @rennet/t3-chat (package.json `exports["."].types`). Hand-written
// so a consumer's tsc (the desktop app, under Rennet's stricter base config) never
// traverses the vendored T3 Code web source that ./index.ts imports; the package's own
// typecheck runs that source under upstream's tsconfig.

import type { T3Session } from "@rennet/protocol";
import type { JSX, LazyExoticComponent } from "react";

export interface T3NativeChatProps {
  readonly session: T3Session;
}

/** Rung two: T3 Code's `ChatView`, mounted natively for the session's bound thread. */
export declare const T3NativeChat: LazyExoticComponent<(props: T3NativeChatProps) => JSX.Element>;
