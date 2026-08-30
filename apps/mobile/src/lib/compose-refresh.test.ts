import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposeRefreshController } from "./compose-refresh";

afterEach(() => {
  vi.useRealTimers();
});

describe("createComposeRefreshController", () => {
  it("retries a transient result in place", async () => {
    vi.useFakeTimers();
    const results: string[] = [];
    let calls = 0;
    const controller = createComposeRefreshController({
      compose: async () => {
        calls += 1;
        return calls === 1 ? { status: "unavailable", retryable: true } : { status: "review" };
      },
      onResult: (result) => results.push(result.status),
      onError: (error) => {
        throw error;
      },
    });

    controller.start();
    await vi.waitFor(() => expect(results).toEqual(["unavailable"]));
    await vi.advanceTimersByTimeAsync(750);
    await vi.waitFor(() => expect(results).toEqual(["unavailable", "review"]));
    expect(calls).toBe(2);
  });

  it("ignores an older in-flight answer after a projection refresh", async () => {
    let resolveFirst!: (value: { status: string }) => void;
    let resolveSecond!: (value: { status: string }) => void;
    const first = new Promise<{ status: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<{ status: string }>((resolve) => {
      resolveSecond = resolve;
    });
    const results: string[] = [];
    let calls = 0;
    const controller = createComposeRefreshController({
      compose: () => (calls++ === 0 ? first : second),
      onResult: (result) => results.push(result.status),
      onError: (error) => {
        throw error;
      },
    });

    controller.start();
    controller.refresh();
    resolveFirst({ status: "old-review" });
    await Promise.resolve();
    expect(results).toEqual([]);
    resolveSecond({ status: "new-review" });
    await vi.waitFor(() => expect(results).toEqual(["new-review"]));
  });

  it("cancels a pending retry and ignores late completion after route exit", async () => {
    vi.useFakeTimers();
    const results: string[] = [];
    let calls = 0;
    const controller = createComposeRefreshController({
      compose: async () => {
        calls += 1;
        return { status: "unavailable", retryable: true };
      },
      onResult: (result) => results.push(result.status),
      onError: (error) => {
        throw error;
      },
    });

    controller.start();
    await vi.waitFor(() => expect(results).toEqual(["unavailable"]));
    controller.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
  });
});
