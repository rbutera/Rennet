// The data seam (C01 §2). The ONLY sanctioned path from a surface to the bridge:
// reads via useCommand, writes via useMutation, live narration via useCommandStream.
// No component calls bridge.invoke directly (a lint rule enforces it).
export { BridgeProvider, useBridge } from "./bridge";
export type { QueryState } from "./cache";
export { commandKey, readCommandId } from "./cache";
export { useInvoke } from "./dispatch";
export { type MutationResult, type UseMutationOptions, useMutation } from "./mutate";
export { type CommandResult, type UseCommandOptions, useCommand } from "./query";
export { type UseCommandStreamParams, useCommandStream } from "./stream";
