import type { RennetBridge } from "@rennet/protocol";
import { contextBridge, ipcRenderer } from "electron";

const bridge: RennetBridge = {
  invoke: (name, input) => ipcRenderer.invoke("rennet:invoke", { name, input }),
  subscribeNarrativeProgress: (reviewId, listener) => {
    const receive = (_event: Electron.IpcRendererEvent, progress: unknown) => {
      const candidate = progress as { reviewId?: unknown };
      if (candidate.reviewId === reviewId) listener(progress as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on("rennet:narrative-progress", receive);
    ipcRenderer.send("rennet:narrative-progress:subscribe", { reviewId });
    return () => {
      ipcRenderer.removeListener("rennet:narrative-progress", receive);
      ipcRenderer.send("rennet:narrative-progress:unsubscribe");
    };
  },
};

contextBridge.exposeInMainWorld("rennet", bridge);
