import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";

// ─────────────────────────────────────────────────────────────────────────────
// Markdown prose in the annotation serif voice (DESIGN.md §serif). Renders a
// markdown string — a PR body, conversation prose — through react-markdown, which
// builds React elements directly: it does NOT use `dangerouslySetInnerHTML` and
// does NOT pass raw HTML through by default, so untrusted markdown can never inject
// markup. Element styling stays COLOR-NEUTRAL (inherits the container's voice —
// `sheet-*` on the paper, `ink-*` elsewhere) so one component fits every surface;
// only accent links and mono code carry their own (voice-shared) treatment.
// ─────────────────────────────────────────────────────────────────────────────

const COMPONENTS: ComponentProps<typeof ReactMarkdown>["components"] = {
  h1: (props) => <h1 className="mt-3 mb-1.5 text-lg font-semibold first:mt-0" {...props} />,
  h2: (props) => <h2 className="mt-3 mb-1.5 text-base font-semibold first:mt-0" {...props} />,
  h3: (props) => <h3 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  p: (props) => <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0" {...props} />,
  a: (props) => (
    <a
      className="text-accent underline underline-offset-2"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  ul: (props) => <ul className="my-1.5 list-disc pl-5" {...props} />,
  ol: (props) => <ol className="my-1.5 list-decimal pl-5" {...props} />,
  li: (props) => <li className="my-0.5" {...props} />,
  code: (props) => <code className="font-mono text-2xs" {...props} />,
  pre: (props) => <pre className="my-2 overflow-auto font-mono text-2xs" {...props} />,
  blockquote: (props) => <blockquote className="my-2 border-l-2 pl-3 opacity-80" {...props} />,
  strong: (props) => <strong className="font-semibold" {...props} />,
  hr: () => <hr className="my-3 opacity-40" />,
};

export function Prose({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`rennet-prose font-serif${className ? ` ${className}` : ""}`}>
      <ReactMarkdown components={COMPONENTS}>{children}</ReactMarkdown>
    </div>
  );
}
