import type { RennetBridge } from "@rennet/protocol";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@rennet/ui";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { DirectoryBrowser } from "./directory-browser";
import { Icon } from "./icon";

/**
 * In-app directory picker modal (source-aware project selection). The native OS folder
 * dialog is retired, so the shell's direct-review "Choose a repository" flow and the PR
 * clone-on-demand fallback pick a path THROUGH this modal — the same `fs.listDir`-backed
 * {@link DirectoryBrowser} the add flow uses — then hand the chosen path back to
 * `repository.choose({ path })`. It lists the CURRENT daemon's filesystem (these flows,
 * unlike the add flow, never switch source), so no source switcher is needed here.
 */
export function DirectoryPickerModal({
  bridge,
  title,
  confirmLabel = "Continue",
  onPick,
  onCancel,
}: {
  bridge: RennetBridge;
  /** The modal heading (e.g. "Choose a repository"). */
  title: string;
  /** The confirm button label. Defaults to "Continue". */
  confirmLabel?: string;
  /** The chosen absolute directory, once the user confirms. */
  onPick(path: string): void;
  /** Dismissed without a pick (Cancel, Escape, or backdrop). */
  onCancel(): void;
}) {
  const [path, setPath] = useState<string | undefined>();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="directory-picker-modal sm:max-w-lg" aria-label={title}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DirectoryBrowser bridge={bridge} onPathChange={setPath} />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!path} onClick={() => path && onPick(path)}>
            {confirmLabel}
            <Icon icon={ArrowRight} className="size-3.5" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
