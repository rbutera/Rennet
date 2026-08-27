import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
