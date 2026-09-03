// Electron's <webview> tag, used by the rung-one T3 chat view (t3code-sidecar-chat). Only
// the attributes that view sets; the element is a plain HTMLElement to React. This file is
// a module (the `export {}`) so the declaration AUGMENTS react's types instead of replacing
// them, which a script-file `declare module "react"` would do.
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          allowpopups?: string;
        },
        HTMLElement
      >;
    }
  }
}
