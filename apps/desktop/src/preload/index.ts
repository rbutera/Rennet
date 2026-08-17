import {
  menuRunPayloadSchema,
  menuTemplateSectionsSchema,
  type ProjectProcessEvent,
  type RennetBridge,
  type ReviewAskStreamEvent,
} from "@rennet/protocol";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

const PROGRESS_CHANNEL = "rennet:progress";
const ASK_STREAM_CHANNEL = "rennet:ask-stream";
const MENU_UPDATE_CHANNEL = "rennet:menu-update";
const MENU_RUN_CHANNEL = "rennet:menu-run";

const bridge: RennetBridge = {
  invoke: (name, input) => ipcRenderer.invoke("rennet:invoke", { name, input }),
  // Subscribe to a command's live progress, keyed by the `commandId` the caller
  // passes to `invoke`. Filters the shared push channel to this invocation and
  // returns an unsubscribe that detaches the exact listener it added.
  onProgress: (commandId, listener) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: { commandId: string; event: ProjectProcessEvent },
    ): void => {
      if (payload.commandId === commandId) listener(payload.event);
    };
    ipcRenderer.on(PROGRESS_CHANNEL, handler);
    return () => ipcRenderer.removeListener(PROGRESS_CHANNEL, handler);
  },
  // Subscribe to a review's conversation token stream (#251), keyed by `reviewId` so
  // it survives a renderer reload while the turn keeps running in main. Filters the
  // shared channel to this review and detaches the exact listener on unsubscribe.
  onAskStream: (reviewId, listener) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: { reviewId: string; event: ReviewAskStreamEvent },
    ): void => {
      if (payload.reviewId === reviewId) listener(payload.event);
    };
    ipcRenderer.on(ASK_STREAM_CHANNEL, handler);
    return () => ipcRenderer.removeListener(ASK_STREAM_CHANNEL, handler);
  },
  // Push the projected application-menu template to MAIN (#44). One-way; MAIN builds
  // and sets the menu.
  updateMenu: (sections) =>
    ipcRenderer.send(MENU_UPDATE_CHANNEL, menuTemplateSectionsSchema.parse(sections)),
  // Subscribe to menu-item activations (#44): MAIN sends the clicked command id; the
  // renderer runs the same handler the palette would. Returns an unsubscribe.
  onMenuRun: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = menuRunPayloadSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data.id);
    };
    ipcRenderer.on(MENU_RUN_CHANNEL, handler);
    return () => ipcRenderer.removeListener(MENU_RUN_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld("rennet", bridge);
