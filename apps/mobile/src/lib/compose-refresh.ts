export interface RetryableComposition {
  readonly status: string;
  readonly retryable?: boolean;
}

export interface ComposeRefreshController {
  start(): void;
  refresh(): void;
  stop(): void;
}

/** Keep one mobile signing preview current across transient failures and cross-client edits.
 * Generations make older in-flight answers inert; stop cancels the retry and every late answer. */
export function createComposeRefreshController<T extends RetryableComposition>(input: {
  readonly compose: () => Promise<T>;
  readonly onResult: (result: T) => void;
  readonly onError: (error: unknown) => void;
  readonly retryDelayMs?: number;
}): ComposeRefreshController {
  let stopped = false;
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const clearRetry = (): void => {
    if (retryTimer === undefined) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const compose = (): void => {
    const attempt = ++generation;
    void input.compose().then(
      (result) => {
        if (stopped || attempt !== generation) return;
        input.onResult(result);
        if (result.status === "unavailable" && result.retryable === true) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            compose();
          }, input.retryDelayMs ?? 750);
        }
      },
      (error: unknown) => {
        if (!stopped && attempt === generation) input.onError(error);
      },
    );
  };

  return {
    start: compose,
    refresh: () => {
      clearRetry();
      compose();
    },
    stop: () => {
      stopped = true;
      generation += 1;
      clearRetry();
    },
  };
}
