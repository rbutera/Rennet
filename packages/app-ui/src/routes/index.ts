// The router foundation (C01 §4): injected history + the #480 route table on a layout
// whose sidebar and chat-dock slot live OUTSIDE the outlet (risk 4). Screens read the
// bridge only through the data seam.
export { RennetRouterApp, type RennetRouterAppProps } from "./app";
export { browserHistory, hashHistory, memoryHistory, type RennetHistory } from "./history";
export { AppLayout } from "./layout";
export { type SlugResolution, useSlugResolution } from "./slug";
export * from "./url";
