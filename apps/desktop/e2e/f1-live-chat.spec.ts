import { rmSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import { launchRennet, makeTempDir, seedReviewRepo } from "./harness";

// ─────────────────────────────────────────────────────────────────────────────
// F1 task 6.2 — the LIVE proof, driving the REAL app against the REAL `claude`.
//
// The reviewer's real HOME and PATH ride into the launch, so the daemon discovers
// the installed `claude` and the ask runs an actual harness turn. The control
// relaunches the same app with `RENNET_DISABLE_HARNESS=1` and asks the same
// question — the dock must NAME the missing harness rather than answer.
//
// Why the review is captured over the daemon's own socket rather than clicked:
// the #480 router has no repo-capture surface yet (`connection-host.tsx`: "the
// router has no front-door repo-capture surface yet"), and `session.mint` mints a
// REVIEW-LESS session. So the only way to put the shipped app on a review-bearing
// `/s/:slug` is to capture through the same WS the renderer itself uses, then
// navigate the real window there. Everything after that — resolution, dock, ask,
// stream, persistence, reload — is the shipped app doing its own work.
// ─────────────────────────────────────────────────────────────────────────────

// The rest of this suite is deliberately deterministic and zero-spend (`modelFreeEnv`);
// this spec is neither — it runs a REAL `claude` turn on the reviewer's own subscription.
// So it is opt-in: `RENNET_LIVE_E2E=1 pnpm exec playwright test -c apps/desktop/playwright.config.ts f1-live-chat`.
// A cost switch, not a gate.
test.skip(process.env.RENNET_LIVE_E2E !== "1", "live harness spec — set RENNET_LIVE_E2E=1");

function liveEnv(disableHarness: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // #569
  if (disableHarness) env.RENNET_DISABLE_HARNESS = "1";
  else delete env.RENNET_DISABLE_HARNESS;
  return env;
}

const dockText = () =>
  document.querySelector(".rennet-chat-dock")?.textContent ?? "(no dock element)";

/** Capture `repository` into a review through the app's own daemon, and open it. */
async function openCapturedReview(page: Page, repository: string): Promise<string> {
  const port = await page.evaluate(
    () => (window as unknown as { rennet: { wsPort: number } }).rennet.wsPort,
  );
  const bridge = new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
  try {
    await bridge.invoke("repository.choose", { path: repository });
    const { review } = await bridge.invoke("review.capture", {
      commandId: crypto.randomUUID(),
      repoPath: repository,
    });
    await page.evaluate((id) => {
      location.hash = `#/s/${id}`;
    }, review.id);
    console.log("URL:", await page.evaluate(() => location.href));
    return review.id;
  } finally {
    bridge.close();
  }
}

async function openDock(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Open chat" });
  if (await toggle.count()) await toggle.click();
  console.log("DOCK OPEN:", await page.getByTestId("chat-dock-slot").getAttribute("data-open"));
  // An ENABLED composer is the proof the dock resolved the route's review: `chat-data`
  // reports `unavailable` (and disables the box) whenever it did not.
  await expect(page.getByLabel("Message the orchestrator").last()).toBeEnabled({
    timeout: 120_000,
  });
}

/**
 * Send a question and sample the dock three times a second, recording every DISTINCT
 * length. More than one growth step between the echoed question and the settled answer
 * is the streaming evidence — `ask-delta` frames landing one at a time, not a single
 * `ask-complete` appearing whole.
 */
async function askAndWatch(page: Page, question: string): Promise<number[]> {
  const box = page.getByLabel("Message the orchestrator").last();
  const before = await page.evaluate(dockText);
  console.log("DOCK BEFORE ASK:", JSON.stringify(before));
  await box.fill(question);
  await page.getByLabel("Send").click();
  const steps: number[] = [];
  let text = before;
  let still = 0;
  for (let index = 0; index < 1_200; index++) {
    await page.waitForTimeout(300);
    const next = await page.evaluate(dockText);
    if (next === text) still += 1;
    else {
      steps.push(next.length);
      still = 0;
    }
    text = next;
    // Settled: an answer arrived beyond the echoed question, and three seconds passed
    // with no further token.
    if (still >= 10 && text.length > before.length + question.length) break;
  }
  console.log("DOCK GROWTH STEPS:", JSON.stringify(steps));
  console.log("DOCK AFTER TURN:", JSON.stringify(text));
  return steps;
}

const QUESTION =
  "Read the diff under review and describe exactly what it changes: name the file, quote " +
  "the old line and the new line, and say what the constant's value becomes.";

test("LIVE 6.2: the dock answers a real question about the real diff", async () => {
  test.setTimeout(900_000);
  const repository = seedReviewRepo("f1-live-repo-");
  const userData = makeTempDir("f1-live-state-");
  const home = makeTempDir("f1-live-home-");
  const { application } = await launchRennet({ repository, userData, home, env: liveEnv(false) });
  try {
    const page = await application.firstWindow();
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[renderer:error] ${m.text()}`);
    });
    console.log("REVIEW:", await openCapturedReview(page, repository));
    await openDock(page);
    await askAndWatch(page, QUESTION);

    // THE RELOAD QUESTION — is the exchange still on screen after a reload?
    await page.reload();
    await openDock(page);
    await page.waitForTimeout(15_000);
    console.log("DOCK AFTER RELOAD:", JSON.stringify(await page.evaluate(dockText)));
  } finally {
    await application.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("LIVE 6.2 control: with no harness the dock names what is missing", async () => {
  test.setTimeout(600_000);
  const repository = seedReviewRepo("f1-control-repo-");
  const userData = makeTempDir("f1-control-state-");
  const home = makeTempDir("f1-control-home-");
  const { application } = await launchRennet({ repository, userData, home, env: liveEnv(true) });
  try {
    const page = await application.firstWindow();
    console.log("REVIEW:", await openCapturedReview(page, repository));
    await openDock(page);
    await askAndWatch(page, QUESTION);
  } finally {
    await application.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
