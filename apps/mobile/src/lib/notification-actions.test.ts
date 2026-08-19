import type { AttentionAction } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { composeAskReply } from "./ask-reply";
import { askCategoryId, chipLabelForAction, shadeActionsFor } from "./notification-actions";

const chips: AttentionAction[] = [
  { id: "a1", label: "Narrow the lock" },
  { id: "a2", label: "Async queue" },
];

describe("notification-actions (#382 M2, task 3.2)", () => {
  it("scopes the category to the review", () => {
    expect(askCategoryId("rev-9")).toBe("ask:rev-9");
  });

  it("maps chips to shade actions, background keeping the app closed", () => {
    const actions = shadeActionsFor(chips, true);
    expect(actions).toEqual([
      { identifier: "a1", buttonTitle: "Narrow the lock", opensAppToForeground: false },
      { identifier: "a2", buttonTitle: "Async queue", opensAppToForeground: false },
    ]);
  });

  it("opens the app on the fallback path", () => {
    expect(shadeActionsFor(chips, false)[0]?.opensAppToForeground).toBe(true);
  });

  it("no chips ⇒ no actions (free-text answer only, never a fabricated chip)", () => {
    expect(shadeActionsFor(undefined, true)).toEqual([]);
    expect(shadeActionsFor([], true)).toEqual([]);
  });

  it("resolves a tapped action to the same reply the in-app card would send", () => {
    const label = chipLabelForAction(chips, "a2");
    expect(label).toBe("Async queue");
    expect(composeAskReply({ chipLabel: label })).toBe("Async queue");
  });

  it("an unknown action (superseded ask) resolves to no label — deep-link, do not guess", () => {
    expect(chipLabelForAction(chips, "gone")).toBeUndefined();
  });
});
