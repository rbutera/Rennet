// @vitest-environment happy-dom
//
// The chrome logo menu (settings discoverability): clicking the top-left Rennet
// mark opens an anchored panel of app destinations; when an update is staged the
// panel grows a highlighted "Restart to update" row and the mark grows its badge.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { ChromeMenu, useUpdateReady } from "./update-ready";

afterEach(() => {
  cleanup();
  useUpdateReady.setState({ ready: null, promptOpen: false });
});

function render(props?: Partial<Parameters<typeof ChromeMenu>[0]>) {
  const onOpenSettings = vi.fn();
  const onBackToProjects = vi.fn();
  const result = mount(
    <ChromeMenu
      size={16}
      className="test-mark"
      version="0.3.6"
      canBackToProjects={true}
      onOpenSettings={onOpenSettings}
      onBackToProjects={onBackToProjects}
      {...props}
    />,
  );
  return { ...result, onOpenSettings, onBackToProjects };
}

describe("ChromeMenu", () => {
  it("is closed until the logo is clicked", () => {
    const { queryByRole, getByRole } = render();
    expect(queryByRole("menu")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Rennet menu" }));
    expect(queryByRole("menu")).not.toBeNull();
  });

  it("Settings runs its action and closes the panel", () => {
    const { getByRole, queryByRole, onOpenSettings } = render();
    fireEvent.click(getByRole("button", { name: "Rennet menu" }));
    fireEvent.click(getByRole("menuitem", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(queryByRole("menu")).toBeNull();
  });

  it("hides Back to projects on the projects root", () => {
    const { getByRole, queryByRole } = render({ canBackToProjects: false });
    fireEvent.click(getByRole("button", { name: "Rennet menu" }));
    expect(queryByRole("menuitem", { name: "Back to projects" })).toBeNull();
  });

  it("shows the version footer and a docs link", () => {
    // The kit Menu portals its panel to the document body, so query the document
    // (not the trigger's container) for panel content — the semantic hook is kept.
    const { getByRole } = render();
    fireEvent.click(getByRole("button", { name: "Rennet menu" }));
    expect(document.querySelector(".chrome-menu-version")?.textContent).toContain("Rennet v0.3.6");
    expect((getByRole("menuitem", { name: "Documentation" }) as HTMLAnchorElement).href).toContain(
      "docs.rennet.dev",
    );
  });

  it("omits the version footer when the host reports none", () => {
    const { getByRole } = render({ version: undefined });
    fireEvent.click(getByRole("button", { name: "Rennet menu" }));
    expect(document.querySelector(".chrome-menu-version")).toBeNull();
  });

  it("badges the mark and offers a restart row only when an update is staged", () => {
    const { getByRole, queryByRole, container } = render();
    fireEvent.click(getByRole("button", { name: "Rennet menu" }));
    expect(queryByRole("menuitem", { name: /Update ready/ })).toBeNull();
    expect(container.querySelector(".chrome-mark-badge")).toBeNull();

    useUpdateReady.getState().markReady({ version: "0.4.0" });
    fireEvent.click(getByRole("menuitem", { name: "Settings" })); // close
    fireEvent.click(getByRole("button", { name: "Rennet menu" }));
    fireEvent.click(getByRole("menuitem", { name: "Update ready — restart into 0.4.0" }));
    expect(useUpdateReady.getState().promptOpen).toBe(true);
    expect(container.querySelector(".chrome-mark-badge")).not.toBeNull();
  });

  it("dismisses on Escape", async () => {
    const { getByRole, queryByRole, user } = render();
    fireEvent.click(getByRole("button", { name: "Rennet menu" }));
    expect(queryByRole("menu")).not.toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(queryByRole("menu")).toBeNull());
  });
});
