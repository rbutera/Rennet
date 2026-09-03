import type { T3Session } from "@rennet/protocol";
import { type ComponentType, createContext, type ReactNode, useContext } from "react";

// The rung-two seam (t3code-sidecar-chat, group 8). app-ui may not import the vendored
// T3 Code web app, so the native ChatView mount arrives from the host: the desktop
// renderer provides `@rennet/t3-chat`'s component here, and the chat slot renders it in
// place of the rung-one <webview>. A host that provides nothing (the browser build)
// keeps rung one.

export interface T3NativeChatProps {
  readonly session: T3Session;
}

const T3ChatSlotContext = createContext<ComponentType<T3NativeChatProps> | null>(null);

export function T3ChatSlotProvider({
  component,
  children,
}: {
  readonly component: ComponentType<T3NativeChatProps>;
  readonly children: ReactNode;
}) {
  return <T3ChatSlotContext.Provider value={component}>{children}</T3ChatSlotContext.Provider>;
}

export function useT3NativeChat(): ComponentType<T3NativeChatProps> | null {
  return useContext(T3ChatSlotContext);
}
