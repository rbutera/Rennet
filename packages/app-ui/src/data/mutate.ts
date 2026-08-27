import type { CommandInput, CommandName, CommandOutput } from "@rennet/protocol";
import { useCallback, useState } from "react";
import { useBridgeContext } from "./bridge";

// ─────────────────────────────────────────────────────────────────────────────
// useMutation (C01 §2.5) — the WRITE hook. `mutate(input)` invokes the command, then
// invalidates the reads it stales BY KEY PREFIX (the command names, declared at the
// call site), so a mounted `useCommand` on any of those names refetches. Writing is
// Rennet's job — it just runs; there is no consent ceremony here (Rule Zero).
// ─────────────────────────────────────────────────────────────────────────────

export interface UseMutationOptions {
  /** Command names whose reads this write stales; each is invalidated by prefix after success. */
  readonly invalidates?: readonly CommandName[];
}

export interface MutationResult<K extends CommandName> {
  readonly mutate: (input: CommandInput<K>) => Promise<CommandOutput<K>>;
  readonly pending: boolean;
  readonly error: unknown;
}

export function useMutation<K extends CommandName>(
  name: K,
  options: UseMutationOptions = {},
): MutationResult<K> {
  const { bridge, cache } = useBridgeContext();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const invalidates = options.invalidates;

  const mutate = useCallback(
    async (input: CommandInput<K>): Promise<CommandOutput<K>> => {
      setPending(true);
      setError(undefined);
      try {
        const output = await bridge.invoke(name, input);
        for (const prefix of invalidates ?? []) cache.invalidate(prefix);
        return output;
      } catch (reason) {
        setError(reason);
        throw reason;
      } finally {
        setPending(false);
      }
    },
    [bridge, cache, name, invalidates],
  );

  return { mutate, pending, error };
}
