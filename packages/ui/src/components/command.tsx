import { Command as CommandPrimitive } from "cmdk";
import { CheckIcon, SearchIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";
import { InputGroup, InputGroupAddon } from "./input-group";

// The standard cmdk-backed shadcn Command, vendored onto the Rennet ramp. cmdk owns
// fuzzy filtering and ↑/↓/Enter keyboard navigation; the surrounding CommandDialog
// reuses the kit Dialog (Base UI) for the portal, focus trap, Escape/outside-dismiss.
// base-nova defaults (raw black scrims, off-ramp radius, palette colors) are mapped to the
// semantic --rn-* utilities; the kit hex-lint + design-ramp guards keep re-pulls honest.
//
// Styling follows `spikes/board-prototype/components/ui/command.tsx`: a padded 12px-corner
// popover holding an INSET search pill and rounded rows, rather than the upstream
// edge-to-edge list with a full-bleed input rule.

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-xl bg-popover p-1 text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog {...props}>
      {/* Anchored a third of the way down instead of centred: the palette grows
       *  DOWNWARDS as results arrive, so a centred popup would jump on every
       *  keystroke. `translate-y-0` cancels the centring transform. */}
      <DialogContent
        className={cn("top-1/3 translate-y-0 overflow-hidden p-0", className)}
        showCloseButton={showCloseButton}
      >
        {/* Inside the content so a CLOSED dialog renders no stray sr-only heading
         * (the content is only mounted while open). */}
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* No size overrides here. The palette is the same control ramp as the rest
         * of the app — the 48px input / 12px rows the upstream template scaled up to
         * belonged to a different scale entirely. */}
        <Command>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      {/* An inset pill, not a full-bleed rule: the group owns the height so the well
       *  and the field agree (the previous h-9 wrapper around an h-10 input clipped
       *  the field by a pixel at every zoom level). */}
      <InputGroup className="border-input/30 bg-input/30">
        {/* `input-group-control`, not a bespoke `command-input` slot: the group draws the
         *  focus ring for THAT slot (`has-[[data-slot=input-group-control]:focus-visible]`),
         *  and the input's own outline is off. Under any other slot name the group's
         *  selector misses and keyboard focus lands with no visible indicator at all. */}
        <CommandPrimitive.Input
          data-slot="input-group-control"
          className={cn(
            "w-full bg-transparent pr-2.5 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        {/* Declared after the input but rendered before it — the addon's `inline-start`
         *  alignment is `order-first`, and the group pads the input to clear it. */}
        <InputGroupAddon>
          <SearchIcon className="size-4 shrink-0 opacity-50" strokeWidth={1.6} />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      // The bar is hidden via ::-webkit-scrollbar only. Setting `scrollbar-width`
      // would switch Chromium 121+ off the ::-webkit-* path the app themes its
      // scrollbars through (index.css) — see that file's note.
      className={cn(
        "max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none [&::-webkit-scrollbar]:hidden",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-sm", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      // `data-[selected=true]`, never the shorthand `data-selected`: cmdk renders the
      // attribute on EVERY row (`data-selected="false"` on the unselected ones), so a
      // presence-matching variant would light the whole list. Proven in additions.test.tsx.
      className={cn(
        "group/command-item relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none in-data-[slot=dialog-content]:rounded-lg! data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-muted data-[selected=true]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[selected=true]:*:[svg]:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      {/* The chosen-row tick. cmdk never sets `data-checked` itself — a picker that
       *  represents a current choice (project picker, model mappings) sets it on the
       *  row, and a row ending in a shortcut hint uses that column instead. It holds
       *  its column when unchecked so a list does not reflow as the choice moves. */}
      <CheckIcon
        strokeWidth={1.6}
        className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100"
      />
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-data-[selected=true]/command-item:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};
