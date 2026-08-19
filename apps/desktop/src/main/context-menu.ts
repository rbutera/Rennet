import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

/** The two effects the template needs; injected so the builder stays pure/testable. */
export interface ContextMenuActions {
  /** Accept a spellcheck suggestion (webContents.replaceMisspelling). */
  replaceMisspelling?(suggestion: string): void;
  /** Put text on the system clipboard (electron's clipboard.writeText). */
  copyText?(text: string): void;
}

/**
 * The system right-click context menu: the OS-native edit verbs (cut / copy /
 * paste / select all), link copying, and spellcheck suggestions — the things a
 * desktop app owes its user for free. Pure template construction, unit-tested;
 * the Electron wiring (`web-contents-created` → `context-menu` → popup) lives
 * in main/index.ts.
 *
 * The menu is CONTEXTUAL, not a fixed list: an editable field gets the edit
 * verbs (enabled per `editFlags`), selected text gets Copy, a link gets Copy
 * Link Address, a misspelling gets its suggestions. An empty template means
 * "show nothing" — right-clicking dead chrome stays silent.
 */
export function buildContextMenuTemplate(
  params: Pick<
    ContextMenuParams,
    "isEditable" | "editFlags" | "selectionText" | "linkURL" | "misspelledWord"
  > & { dictionarySuggestions?: string[] },
  actions: ContextMenuActions = {},
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  // Spellcheck suggestions lead (that is where the OS puts them), then the verbs.
  if (params.misspelledWord && actions.replaceMisspelling) {
    const replace = actions.replaceMisspelling;
    for (const suggestion of (params.dictionarySuggestions ?? []).slice(0, 5)) {
      template.push({ label: suggestion, click: () => replace(suggestion) });
    }
    if (template.length > 0) template.push({ type: "separator" });
  }

  if (params.isEditable) {
    template.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );
  } else if (params.selectionText.trim().length > 0) {
    template.push({ role: "copy" });
  }

  if (params.linkURL && actions.copyText) {
    const copy = actions.copyText;
    const link = params.linkURL;
    if (template.length > 0) template.push({ type: "separator" });
    template.push({ label: "Copy Link Address", click: () => copy(link) });
  }

  return template;
}
