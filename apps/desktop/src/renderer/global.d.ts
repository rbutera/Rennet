import type { RennetBridge } from "@rennet/protocol";

declare global {
  interface Window {
    rennet: RennetBridge;
  }
}
