import { describe, expect, it } from "vitest";
import { renderUiVerificationPrompt, UI_VERIFICATION_CONTRACT } from "./index";

describe("renderUiVerificationPrompt (#183)", () => {
  it("carries the four contract slots, the design intent, the evidence dir, and the changed files", () => {
    const prompt = renderUiVerificationPrompt(UI_VERIFICATION_CONTRACT, {
      files: [{ path: "src/App.tsx", hunk: "+ <button>Go</button>" }],
      designIntent: "Title: Add a sign-in button",
      evidenceDir: "/store/ui-evidence/review-1",
    });
    expect(prompt).toContain(
      `verify-ui: mount, screenshot, a11y@${UI_VERIFICATION_CONTRACT.version}`,
    );
    expect(prompt).toContain(UI_VERIFICATION_CONTRACT.role);
    expect(prompt).toContain(UI_VERIFICATION_CONTRACT.failureValve);
    expect(prompt).toContain("Title: Add a sign-in button");
    expect(prompt).toContain("/store/ui-evidence/review-1");
    expect(prompt).toContain("src/App.tsx");
    expect(prompt).toContain("+ <button>Go</button>");
  });

  it("degrades honestly when no intent was captured (compare against the change itself)", () => {
    const prompt = renderUiVerificationPrompt(UI_VERIFICATION_CONTRACT, {
      files: [{ path: "styles/main.css", hunk: "" }],
      designIntent: "",
      evidenceDir: "/ev",
    });
    expect(prompt).toContain("no stated intent was captured");
    expect(prompt).toContain("Changed hunk: (unavailable)");
  });
});
