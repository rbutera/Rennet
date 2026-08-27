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
        "inline-flex w-fit items-center gap-0.5 rounded-md bg-muted p-0.75 data-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup };
