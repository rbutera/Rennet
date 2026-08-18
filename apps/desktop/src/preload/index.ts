import {
  type MenuTemplateSection,
  menuRunPayloadSchema,
  menuTemplateSectionsSchema,
} from "@rennet/protocol";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

// The preload no longer forwards commands or filters push streams — those moved to the
// loopback WS transport (#378), which the renderer reaches through @rennet/client's
// WsRennetBridge. What remains is the Electron-native residue the renderer merges with
// that bridge: the host platform, the WS port to dial, and the application-menu channels.
const MENU_UPDATE_CHANNEL = "rennet:menu-update";
const MENU_RUN_CHANNEL = "rennet:menu-run";
const CHOOSE_DIRECTORY_CHANNEL = "rennet:choose-directory";
const WS_PORT_ARG = "--rennet-ws-port=";

/** The Electron-native surface the preload injects as `window.rennet`. */
export interface RennetPreload {
  /** The host platform (`process.platform`), so the renderer can gate macOS-only chrome. */
  readonly platform: string;
  /** The loopback WS port the server bound (#378), read from the injected argv flag. */
  readonly wsPort: number;
  /** Push the projected application-menu template to MAIN (#44). One-way. */
  updateMenu(sections: MenuTemplateSection[]): void;
  /** Subscribe to menu-item activations (#44); returns an unsubscribe. */
  onMenuRun(listener: (id: string) => void): () => void;
  /**
   * Open the native directory picker and resolve the chosen path, or null if cancelled
   * (#379). A detached daemon cannot open a dialog, so the renderer obtains the path here
   * and forwards it to `repository.choose`. Honors RENNET_TEST_REPO on the main side.
   */
  chooseDirectory(): Promise<string | null>;
}

// The WS port is a boot-time constant injected via webPreferences.additionalArguments;
// it lands in the sandboxed preload's `process.argv`.
const wsPortArg = process.argv.find((arg) => arg.startsWith(WS_PORT_ARG));
const wsPort = wsPortArg ? Number.parseInt(wsPortArg.slice(WS_PORT_ARG.length), 10) : 0;

const preload: RennetPreload = {
  platform: process.platform,
  wsPort,
  updateMenu: (sections) =>
    ipcRenderer.send(MENU_UPDATE_CHANNEL, menuTemplateSectionsSchema.parse(sections)),
  onMenuRun: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = menuRunPayloadSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data.id);
    };
    ipcRenderer.on(MENU_RUN_CHANNEL, handler);
    return () => ipcRenderer.removeListener(MENU_RUN_CHANNEL, handler);
  },
  chooseDirectory: () => ipcRenderer.invoke(CHOOSE_DIRECTORY_CHANNEL) as Promise<string | null>,
};

contextBridge.exposeInMainWorld("rennet", preload);
