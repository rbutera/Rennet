import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { mergeClassName } from "../lib/utils";

// Segmented control container. "No selection" is the empty array Base UI models
// natively (`value={[]}` / `defaultValue={[]}`) — never the "" sentinel that the
// hand-rolled controls this primitive replaces reached for. Put `<Toggle value=…>`
// members inside; a single-select group is the default (multiple={false}).
function ToggleGroup({ className, ...props }: ToggleGroupPrimitive.Props) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={mergeClassName(
        // Base UI 1.7 emits data-orientation="vertical" (not data-vertical); a segmented
        // control uses the 6px (rounded-md) radius per DESIGN.md.
        //
        // The tray is a hairline-bordered, barely-tinted well — NOT a solid raised slab.
        // The raised fill belongs to the lit member alone, so the selection reads against
        // the tray instead of sitting on the same tone (prototype segmented controls,
        // e.g. `components/new-chat-view.tsx:156`). A caller that wants a bare wrapping
        // grid of pills (settings glyph picker, PillChoice) opts out with
        // `border-transparent bg-transparent p-0`.
        "inline-flex w-fit items-center gap-0.5 rounded-md border border-border bg-card/40 p-0.5 data-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup };
