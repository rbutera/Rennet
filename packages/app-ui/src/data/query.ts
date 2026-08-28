import type { CommandInput, CommandName, CommandOutput } from "@rennet/protocol";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useBridgeContext } from "./bridge";
import { commandKey, type QueryState } from "./cache";

// ─────────────────────────────────────────────────────────────────────────────
// useCommand (C01 §2.3) — the READ hook. A component reads exactly one thing: the
// cache entry keyed by command name + canonically serialized input. In-flight fetches
// dedupe (two components, one key → one invoke); an invalidation marks the entry stale
// and a mounted reader refetches; a rejection surfaces as `error`, never an unhandled
// throw. `pending` is "no data or error yet" (first load); a background refetch after
// invalidate keeps the old `data` and raises `stale`, not `pending`.
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandResult<T> {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly pending: boolean;
  readonly stale: boolean;
}

export interface UseCommandOptions {
  /** When false, the read does not fetch (its cache entry stays idle). Default true. */
  readonly enabled?: boolean;
}

export function useRefreshCommand(name: CommandName): () => void {
  const { cache } = useBridgeContext();
  return useCallback(() => cache.invalidate(name), [cache, name]);
}

export function useCommand<K extends CommandName>(
  name: K,
  input: CommandInput<K>,
  options: UseCommandOptions = {},
): CommandResult<CommandOutput<K>> {
  const { bridge, cache } = useBridgeContext();
  const enabled = options.enabled ?? true;
  const key = commandKey(name, input);

  // The latest name/input/bridge, read inside the effect so the deps stay the stable
  // string `key` (not a fresh input object each render, which would re-fire endlessly).
  const latest = useRef({ bridge, name, input });
  latest.current = { bridge, name, input };

  const snapshot = useSyncExternalStore(
    useCallback((onChange) => cache.subscribe(key, onChange), [cache, key]),
    useCallback(() => cache.getSnapshot(key) as QueryState<CommandOutput<K>>, [cache, key]),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot.stale is an intentional re-run trigger, not a body reference — when `invalidate` flips the entry stale, this effect must re-run so `ensure` refetches. Invoke args come from `latest` (a ref), keeping the deps the stable `key` string rather than a fresh input object each render.
  useEffect(() => {
    if (!enabled) return;
    const { bridge: b, name: n, input: i } = latest.current;
    cache.ensure(key, () => b.invoke(n, i));
  }, [cache, key, enabled, snapshot.stale]);

  return {
    data: snapshot.data,
    error: snapshot.error,
    pending: enabled && snapshot.data === undefined && snapshot.error === undefined,
    stale: snapshot.stale,
  };
}
