import { describe, expect, it } from "vitest";
import { liveProbe, liveProbeMap } from "./live-detection";

// C17 review finding 2: detection answers were memoized for the daemon's lifetime, so
// installing or removing a CLI never changed what the host cards reported until restart.
// These are the two properties that replace it — share the RUNNING probe, never the settled one.

describe("liveProbe — share in flight, re-probe after", () => {
  it("POSITIVE CONTROL: the call AFTER a probe settles runs a fresh one", async () => {
    // Hold the answer (the old `??=` memoization) and this fails: the second read would
    // report `gh` still installed after it was removed, which is the whole defect.
    const share = liveProbe<string>();
    let answer = "gh 2.89.0";
    let runs = 0;
    const probe = () =>
      share(async () => {
        runs += 1;
        return answer;
      });

    expect(await probe()).toBe("gh 2.89.0");
    answer = "not-installed"; // the machine changed under a LIVE daemon.
    expect(await probe()).toBe("not-installed");
    expect(runs).toBe(2);
  });

  it("concurrent callers share ONE probe (the cost the memoization was paying for)", async () => {
    const share = liveProbe<number>();
    let runs = 0;
    const probe = () =>
      share(async () => {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return runs;
      });

    expect(await Promise.all([probe(), probe(), probe()])).toEqual([1, 1, 1]);
    expect(runs).toBe(1);
    // …and the share is released, so a later read is a new probe.
    expect(await probe()).toBe(2);
  });

  it("a REJECTED probe is evicted too — a failure is not cached as an answer", async () => {
    const share = liveProbe<string>();
    let fail = true;
    const probe = () =>
      share(async () => {
        if (fail) throw new Error("distro unreachable");
        return "ok";
      });

    await expect(probe()).rejects.toThrow("distro unreachable");
    fail = false;
    expect(await probe()).toBe("ok");
  });
});

describe("liveProbeMap — the same share, per host", () => {
  it("keys are independent and each re-probes after its own settlement", async () => {
    const share = liveProbeMap<string>();
    const seen: string[] = [];
    const probe = (host: string) =>
      share(host, async () => {
        seen.push(host);
        return `${host}:${seen.length}`;
      });

    expect(await probe("local")).toBe("local:1");
    expect(await probe("wsl:Ubuntu")).toBe("wsl:Ubuntu:2");
    // A second read of the SAME host re-probes rather than replaying the first answer.
    expect(await probe("local")).toBe("local:3");
    expect(seen).toEqual(["local", "wsl:Ubuntu", "local"]);
  });
});
