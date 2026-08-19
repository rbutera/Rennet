import { describe, expect, it, vi } from "vitest";
import { buildContextMenuTemplate } from "./context-menu";

const EDIT_FLAGS = {
  canUndo: false,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: false,
};

function params(overrides: Partial<Parameters<typeof buildContextMenuTemplate>[0]> = {}) {
  return {
    isEditable: false,
    editFlags: EDIT_FLAGS,
    selectionText: "",
    linkURL: "",
    misspelledWord: "",
    ...overrides,
  };
}

describe("buildContextMenuTemplate", () => {
  it("an editable field gets the OS edit verbs, enabled per editFlags", () => {
    const template = buildContextMenuTemplate(
      params({
        isEditable: true,
        editFlags: { ...EDIT_FLAGS, canCut: false, canPaste: true },
      }),
    );
    const roles = template.map((item) => item.role ?? item.type);
    expect(roles).toEqual(["cut", "copy", "paste", "separator", "selectAll"]);
    expect(template[0]?.enabled).toBe(false); // cut disabled: nothing cuttable
    expect(template[2]?.enabled).toBe(true); // paste enabled
  });

  it("selected text in a non-editable surface gets Copy alone", () => {
    const template = buildContextMenuTemplate(params({ selectionText: "some code" }));
    expect(template.map((item) => item.role)).toEqual(["copy"]);
  });

  it("dead chrome gets NOTHING — an empty template, no popup", () => {
    expect(buildContextMenuTemplate(params())).toEqual([]);
  });

  it("a link gets Copy Link Address wired to the clipboard action", () => {
    const copyText = vi.fn();
    const template = buildContextMenuTemplate(
      params({ linkURL: "https://github.com/rbutera/rennet/pull/410" }),
      { copyText },
    );
    const item = template.find((entry) => entry.label === "Copy Link Address");
    if (!item) throw new Error("Copy Link Address item missing");
    (item.click as () => void)();
    expect(copyText).toHaveBeenCalledWith("https://github.com/rbutera/rennet/pull/410");
  });

  it("a misspelling leads with up to five suggestions wired to replaceMisspelling", () => {
    const replaceMisspelling = vi.fn();
    const template = buildContextMenuTemplate(
      params({
        isEditable: true,
        misspelledWord: "recieve",
        dictionarySuggestions: ["receive", "relieve", "reprieve", "retrieve", "believe", "sixth"],
      }),
      { replaceMisspelling },
    );
    const first = template[0];
    if (!first) throw new Error("suggestions missing");
    expect(first.label).toBe("receive");
    expect(template.filter((item) => item.label && !item.role).length).toBe(5); // capped
    (first.click as () => void)();
    expect(replaceMisspelling).toHaveBeenCalledWith("receive");
    // The edit verbs still follow, after a separator.
    expect(template.some((item) => item.role === "paste")).toBe(true);
  });
});
