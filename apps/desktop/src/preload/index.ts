import type { RennetBridge } from "@rennet/protocol";
import { contextBridge, ipcRenderer } from "electron";

const bridge: RennetBridge = {
  invoke: (name, input) => ipcRenderer.invoke("rennet:invoke", { name, input }),
};

contextBridge.exposeInMainWorld("rennet", bridge);
