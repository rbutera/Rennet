import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/* twMerge's default config only knows Tailwind's stock text sizes, so it files
 * Rennet's ramp steps (text-10, text-2xs, text-12-5, text-13, text-15,
 * text-display) under text-COLOR and drops whichever of `text-13`/`text-primary`
 * comes first in a merge. Registering them as font sizes keeps size and colour
 * in separate merge groups. */
const twMergeRennet = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["10", "2xs", "12-5", "13", "15", "display"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMergeRennet(clsx(inputs));
}

/**
 * Merge a wrapper's own classes with a Base UI `className` that may be the function
 * form `(state) => string`. `cn`/clsx silently DROP a function, so a consumer's
 * state-aware className would vanish. When the incoming className is a function,
 * return a function that resolves it against Base UI's state before merging;
 * otherwise merge as a plain string.
 */
export function mergeClassName<State>(
  own: ClassValue,
  incoming: string | ((state: State) => string | undefined) | undefined,
): string | ((state: State) => string) {
  return typeof incoming === "function" ? (state) => cn(own, incoming(state)) : cn(own, incoming);
}
