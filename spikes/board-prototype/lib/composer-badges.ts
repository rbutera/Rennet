/**
 * Small references attached to a composer message before it's sent —
 * e.g. a pasted image or a comment left on a specific code line from a
 * CodeBlock. Rendered as removable pills above the input.
 *
 * This is intentionally a small, extensible union: new attachment kinds
 * (a file, a terminal selection, a design frame, ...) should be added as
 * additional variants here rather than bolting ad-hoc fields onto these.
 */
export type ComposerBadge =
  | {
      id: string
      kind: "image"
      name: string
      thumbnailUrl: string
    }
  | {
      id: string
      kind: "comment"
      path: string
      line: number
      text: string
    }
  | {
      id: string
      kind: "quote"
      /** The highlighted prose the comment anchors to. */
      quote: string
      text: string
    }
