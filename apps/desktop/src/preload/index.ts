import type { ProjectProcessEvent, RennetBridge } from "@rennet/protocol";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

const PROGRESS_CHANNEL = "rennet:progress";

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
};

contextBridge.exposeInMainWorld("rennet", bridge);
