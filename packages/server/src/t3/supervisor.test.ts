import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAKE_SIDECAR } from "./fake-sidecar";
import { findHealthySidecar, isProcessAlive, readSidecarClaim } from "./sidecar";
import { createT3SidecarSupervisor } from "./supervisor";

// ─────────────────────────────────────────────────────────────────────────────
// The sidecar starts at daemon LAUNCH, not at the first `chat.t3Session` (#849).
//
// The proof this file insists on is that the sidecar is genuinely RUNNING before anything
// asks for a session: a live pid and an HTTP probe that a real listener answers, taken
// while no test in it has called `ensure`, `session`, `client` or `threadFor`. Asserting
// that `start()` called something would prove nothing — the defect being fixed is that a
// reviewer waited ~1s at the dock, and only a sidecar that is actually up removes that.
//
// The second thing it insists on is that eager cannot mean fragile: a bring-up that fails
// leaves the supervisor `degraded` with the reason, and `start()` itself neither throws nor
// leaves a rejected promise behind. The unhandled-rejection half is load-bearing and vitest
// enforces it for us — without the `.catch` at the float point in `start()`, the failing
// bring-up below surfaces as an unhandled rejection and reddens the run.
// ─────────────────────────────────────────────────────────────────────────────

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rennet-t3-supervisor-"));
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const dataDir = join(root, "data");
  const bundlePath = join(root, "fake-t3.cjs");
  writeFileSync(bundlePath, FAKE_SIDECAR);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home") };
  return { root, dataDir, bundlePath, env };
}

function supervisor(
  f: ReturnType<typeof fixture>,
  overrides: { bundlePath?: string | undefined } = {},
) {
  const s = createT3SidecarSupervisor({
    dataDir: f.dataDir,
    env: f.env,
    bundlePath: "bundlePath" in overrides ? overrides.bundlePath : f.bundlePath,
    resolveBinaries: async () => ({}),
    // Swallow the daemon's own warn line; the status carries the same reason.
    warn: () => undefined,
  });
  cleanups.push(() => s.stopSync());
  return s;
}

describe("t3 supervisor: eager start (#849)", () => {
  it("has the sidecar listening before anything asks for a session", async () => {
    const f = fixture();
    const s = supervisor(f);
    expect(s.status().state).toBe("off");

    s.start();

    // From here to the assertions below, NOTHING calls ensure/session/client/threadFor.
    // The only reader is `status()`, and `status()` starts no sidecar.
    await vi.waitFor(() => expect(s.status().state).toBe("ready"), {
      timeout: 20_000,
      interval: 25,
    });

    // A status flag is a claim. These two are the sidecar itself: a pid this machine is
    // really running, and a listener that answers its own unauthenticated probe.
    const claim = readSidecarClaim(f.dataDir);
    expect(claim).not.toBeNull();
    expect(isProcessAlive((claim as { pid: number }).pid)).toBe(true);
    expect((await findHealthySidecar(f.dataDir)).kind).toBe("healthy");

    // Only NOW does the first `chat.t3Session` equivalent run, and it is handed the
    // sidecar that is already up rather than starting one.
    const session = await s.session();
    expect(session.origin).toBe(`http://127.0.0.1:${(claim as { port: number }).port}`);
    expect(session.accessToken.length).toBeGreaterThan(10);
  }, 40_000);

  it("leaves the supervisor degraded with the reason when the sidecar cannot start", async () => {
    const f = fixture();
    // A bundle path that exists in the options but not on disk: node exits non-zero and the
    // readiness poll never sees a runtime file, which is the shape of a real failed spawn.
    const s = supervisor(f, { bundlePath: join(f.root, "not-built.mjs") });

    expect(() => s.start()).not.toThrow();

    await vi.waitFor(() => expect(s.status().state).toBe("degraded"), {
      timeout: 30_000,
      interval: 50,
    });
    const status = s.status() as { state: "degraded"; detail: string };
    expect(status.detail.length).toBeGreaterThan(0);
    // Nothing is running, and nothing pretends otherwise.
    expect(readSidecarClaim(f.dataDir)).toBeNull();
  }, 60_000);

  it("starts nothing when there is no bundle, and still names the missing bundle on demand", async () => {
    const f = fixture();
    const s = supervisor(f, { bundlePath: undefined });

    s.start();
    // No spawn, no `starting`, no log line: a build with no vendored bundle was never going
    // to have a sidecar, so launch stays silent about it.
    expect(s.status().state).toBe("off");

    // The honest answer is still there for whoever asks — the existing shape #849 keeps.
    await expect(s.ensure()).rejects.toThrow(/vendored T3 Code server bundle is not built/);
    expect(s.status().state).toBe("degraded");
  }, 20_000);
});
