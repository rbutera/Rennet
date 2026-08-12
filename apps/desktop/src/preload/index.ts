import type {
  ProjectProcessEvent,
  RennetBridge,
  ReviewAskStreamEvent,
} from "@rennet/protocol";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

const PROGRESS_CHANNEL = "rennet:progress";
const ASK_STREAM_CHANNEL = "rennet:ask-stream";

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
};

contextBridge.exposeInMainWorld("rennet", bridge);
