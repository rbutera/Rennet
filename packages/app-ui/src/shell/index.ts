// The frame's shell surface (C03 chrome + C11 command menu / key owner). Frame chrome
// and the ONE global key owner's public API. The command-menu ENTRY builders and the
// key-action CATALOGUE stay module-private — a later overlay registers a layer through
// `useKeyLayer`; it does not reach the internal tables.

export { CommandMenu } from "./command-menu";
export { type KeyLayerHandler, KeyOwner, useKeyLayer } from "./key-owner";
