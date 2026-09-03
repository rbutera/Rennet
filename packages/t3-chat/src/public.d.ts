// The typed surface of @rennet/t3-chat (package.json `exports["."].types`). Hand-written
// so a consumer's tsc (the desktop app, under Rennet's stricter base config) never
// traverses the vendored T3 Code web source that ./index.ts imports; the package's own
// typecheck runs that source under upstream's tsconfig.

import type { LaneThreadRef, T3Session } from "@rennet/protocol";
import type { JSX, LazyExoticComponent } from "react";

export interface T3NativeChatProps {
  readonly session: T3Session;
}

export interface T3ThreadViewProps {
  readonly session: T3Session;
  readonly thread: LaneThreadRef;
  readonly readOnly: true;
}

/** Rung two: T3 Code's `ChatView`, mounted natively for the session's bound thread. */
export declare const T3NativeChat: LazyExoticComponent<(props: T3NativeChatProps) => JSX.Element>;

/** The same mount pointed at a lens seat's thread, read-only: streaming, no composer. */
export declare const T3ThreadView: LazyExoticComponent<(props: T3ThreadViewProps) => JSX.Element>;
