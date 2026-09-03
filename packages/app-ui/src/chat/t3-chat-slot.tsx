import type { LaneThreadRef, T3Session } from "@rennet/protocol";
import { type ComponentType, createContext, type ReactNode, useContext } from "react";

// The native-mount seam (t3code-sidecar-chat, group 8). app-ui may not import the vendored
// T3 Code web app, so the native ChatView mounts arrive from the host: both of the desktop
// package's entries — the Electron renderer and the served browser tab — provide
// `@rennet/t3-chat`'s components here. The <webview> fallback they replaced is deleted
// (t3-lens-threads 4.4), so a host that provides nothing says so rather than showing an
// empty box. Two components, because the slot has two jobs (t3-lens-threads 3.3): the
// review's own thread with its composer, and a lens seat's transcript read-only.

export interface T3NativeChatProps {
  readonly session: T3Session;
}

export interface T3ThreadViewProps {
  readonly session: T3Session;
  readonly thread: LaneThreadRef;
  readonly readOnly: true;
}

export interface T3ChatSlotComponents {
  /** The review's bound thread, composer and all. */
  readonly session: ComponentType<T3NativeChatProps>;
  /** Any other thread on the same sidecar environment, read-only. */
  readonly thread: ComponentType<T3ThreadViewProps>;
}

const T3ChatSlotContext = createContext<T3ChatSlotComponents | null>(null);

export function T3ChatSlotProvider({
  session,
  thread,
  children,
}: T3ChatSlotComponents & { readonly children: ReactNode }) {
  return (
    <T3ChatSlotContext.Provider value={{ session, thread }}>{children}</T3ChatSlotContext.Provider>
  );
}

export function useT3ChatSlot(): T3ChatSlotComponents | null {
  return useContext(T3ChatSlotContext);
}
