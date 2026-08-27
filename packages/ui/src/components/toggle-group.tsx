import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { cn } from "../lib/utils";

// Segmented control container. "No selection" is the empty array Base UI models
// natively (`value={[]}` / `defaultValue={[]}`) — never the "" sentinel that the
// hand-rolled controls this primitive replaces reached for. Put `<Toggle value=…>`
// members inside; a single-select group is the default (multiple={false}).
function ToggleGroup({ className, ...props }: ToggleGroupPrimitive.Props) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn(
        "inline-flex w-fit items-center gap-0.5 rounded-lg bg-muted p-0.75 data-vertical:flex-col",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup };
