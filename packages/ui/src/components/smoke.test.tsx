// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Button } from "./button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog";

test("button renders and clicks", async () => {
  let hits = 0;
  render(<Button onClick={() => hits++}>Ripen</Button>);
  await userEvent.click(screen.getByRole("button", { name: "Ripen" }));
  expect(hits).toBe(1);
});

test("dialog opens, traps focus, closes on escape", async () => {
  render(
    <Dialog>
      <DialogTrigger>open</DialogTrigger>
      <DialogContent>
        <DialogTitle>Affinage</DialogTitle>
      </DialogContent>
    </Dialog>,
  );
  await userEvent.click(screen.getByText("open"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
});
