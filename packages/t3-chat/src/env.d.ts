/// <reference types="vite/client" />

import type { DesktopBridge } from "@t3tools/contracts";

// The vendored web source reads these at module scope (branding.ts, hostedPairing.ts,
// environments/primary/target.ts). The desktop renderer's Vite config `define`s the two
// that matter for the mount: APP_VERSION and VITE_HOSTED_APP_CHANNEL; the rest read as
// undefined, which every call site already tolerates.
declare global {
  interface ImportMetaEnv {
    readonly VITE_HTTP_URL?: string;
    readonly VITE_WS_URL?: string;
    readonly VITE_HOSTED_APP_URL?: string;
    readonly VITE_HOSTED_APP_CHANNEL?: string;
    readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
    readonly VITE_CLERK_JWT_TEMPLATE?: string;
    readonly VITE_CLERK_CLI_OAUTH_CLIENT_ID?: string;
    readonly VITE_RELAY_OTLP_TRACES_URL?: string;
    readonly VITE_RELAY_OTLP_TRACES_DATASET?: string;
    readonly VITE_RELAY_OTLP_TRACES_TOKEN?: string;
    readonly VITE_DEV_SERVER_URL?: string;
    readonly APP_VERSION: string;
  }

  interface Window {
    desktopBridge?: DesktopBridge;
  }
}
