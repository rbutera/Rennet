// @vitest-environment happy-dom
//
// The markdown prose renderer (Wave 3, Task 3.3). It turns a markdown string into
// real elements — emphasis, code, links — and, by construction (react-markdown's
// default), never injects raw HTML: a `<script>` in the source is inert text, not a
// node. These assertions check the produced ELEMENTS, not just visible text.
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { Prose } from "./prose";

describe("Prose", () => {
  it("renders emphasis, inline code, and links from markdown", () => {
    const { container } = mount(
      <Prose>{"Ripen the *wheel* with `codeToTokens` — see [docs](https://example.com/x)."}</Prose>,
    );
    expect(container.querySelector("em")?.textContent).toBe("wheel");
    expect(container.querySelector("code")?.textContent).toBe("codeToTokens");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/x");
    expect(link?.textContent).toBe("docs");
  });

  it("renders headings and list items", () => {
    const { container } = mount(<Prose>{"## What\n\n- first\n- second"}</Prose>);
    expect(container.querySelector("h2")?.textContent).toBe("What");
    expect(container.querySelectorAll("li").length).toBe(2);
  });

  it("does not inject raw HTML (no dangerouslySetInnerHTML path)", () => {
    const { container } = mount(
      <Prose>{"Safe <script>window.__pwned = true</script> and <b>bold?</b>"}</Prose>,
    );
    // react-markdown escapes raw HTML by default: no <script>/<b> nodes appear…
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    // …the raw tags survive as literal text instead.
    expect(container.textContent).toContain("<script>");
    expect(container.textContent).toContain("<b>bold?</b>");
  });
});
