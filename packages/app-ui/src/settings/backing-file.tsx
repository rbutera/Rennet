// ─────────────────────────────────────────────────────────────────────────────
// BackingFile (C10 §1.3, claim 578) — the shared monospace caption that names the
// file a settings section actually reads and writes (`~/.rennet/client-settings.json`,
// `~/.rennet/daemon-settings.json`, or `.rennet/` inside a project). It is honest
// provenance for the section as a whole: the reader can go open the file. Rendered
// beside a section title by `Section`, and reusable standalone.
// ─────────────────────────────────────────────────────────────────────────────

export function BackingFile({ file }: { readonly file: string }) {
  return (
    <span data-slot="backing-file" className="font-mono text-2xs text-ink-faint">
      {file}
    </span>
  );
}
