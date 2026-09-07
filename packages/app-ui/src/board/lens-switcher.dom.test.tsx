// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { mount } from "../test/dom";
import { lensSeatStates } from "./lens-seats";
import { LensSwitcher } from "./lens-switcher";

it("explains waiting Noise on keyboard focus and hover without selecting it", async () => {
  const seats = lensSeatStates(
    {
      lanes: [
        { id: "noise", label: "Noise", status: "waiting" },
        { id: "sequence", label: "Sequence", status: "running" },
      ],
      running: true,
    },
    {
      design: { status: "missing" },
      sequence: { status: "missing" },
      decisions: { status: "missing" },
      flagged: { status: "missing" },
      noise: { status: "missing" },
    },
  );
  const onSelect = vi.fn();
  const { getByRole, findByRole, user } = mount(
    <LensSwitcher
      lenses={[{ lens: "noise", seat: seats.noise }]}
      selected={null}
      onSelect={onSelect}
    />,
  );
  const noise = getByRole("tab", { name: /^Noise/ });
  const nativeMatches = noise.matches.bind(noise);
  // happy-dom does not implement keyboard :focus-visible matching.
  const matches = vi
    .spyOn(noise, "matches")
    .mockImplementation((selector) => selector === ":focus-visible" || nativeMatches(selector));
  try {
    noise.focus();
    expect((await findByRole("tooltip")).textContent).toBe(
      "Noise reviews what remains once the other lenses have finished.",
    );
    await user.click(noise);
    expect(onSelect).not.toHaveBeenCalled();
    noise.blur();
    await user.unhover(noise);
    await user.hover(noise);
    expect((await findByRole("tooltip")).textContent).toBe(
      "Noise reviews what remains once the other lenses have finished.",
    );
  } finally {
    matches.mockRestore();
  }
});
