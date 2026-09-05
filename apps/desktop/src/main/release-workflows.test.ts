import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const releaseWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/release.yml"),
  "utf8",
);
const autoReleaseWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/auto-release.yml"),
  "utf8",
);

describe("release workflow boundaries", () => {
  const versionExpression = "$" + "{version}";

  it.each([
    ["manual", releaseWorkflow],
    ["automatic", autoReleaseWorkflow],
  ])("keeps the %s macOS build signed, notarized, stapled, and verified", (_name, workflow) => {
    expect(workflow).toContain("environment: release");
    expect(workflow).toContain(
      "APPLE_CERTIFICATE_BASE64: $" + "{{ secrets.APPLE_CERTIFICATE_BASE64 }}",
    );
    expect(workflow).toContain("xcrun notarytool submit");
    expect(workflow).toContain("xcrun stapler staple");
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain("spctl -a -vvv -t exec");
    expect(workflow).toContain("Remove signing material");
    expect(workflow).toContain("rm -rf apps/desktop/out");
    expect(workflow).toContain(`Rennet-${versionExpression}-arm64.dmg`);
    expect(workflow).toContain(`Rennet-darwin-arm64-${versionExpression}.zip`);
  });

  it("cannot run from a pull request or pull_request_target event", () => {
    for (const workflow of [releaseWorkflow, autoReleaseWorkflow]) {
      expect(workflow).not.toMatch(/^\s*pull_request(?:_target)?:/m);
    }
  });

  it("keeps write permission local to release publication", () => {
    expect(releaseWorkflow).toMatch(/permissions:\n {2}contents: read/);
    expect(releaseWorkflow).toMatch(/environment: release\n {4}permissions:\n {6}contents: write/);
    expect(autoReleaseWorkflow).toMatch(/permissions:\n {2}contents: read/);
    expect(autoReleaseWorkflow).not.toMatch(/^permissions:\n {2}contents: write/m);
  });

  it("continues packaging after reusing a skipped green gate", () => {
    expect(autoReleaseWorkflow).toMatch(
      / {2}build-linux-native:\n {4}needs: version\n {4}if: \$\{\{ always\(\) && needs\.version\.result == 'success' \}\}/,
    );
    expect(autoReleaseWorkflow).toMatch(
      / {2}build-macos:\n {4}needs: version\n {4}if: \$\{\{ always\(\) && needs\.version\.result == 'success' \}\}/,
    );
    expect(autoReleaseWorkflow).toMatch(
      / {2}build-windows:\n {4}needs: \[version, build-linux-native\]\n {4}if: \$\{\{ always\(\) && needs\.version\.result == 'success' && needs\.build-linux-native\.result == 'success' \}\}/,
    );
    expect(autoReleaseWorkflow).toMatch(
      / {2}publish:\n {4}needs: \[version, build-macos, build-windows\]\n {4}if: \$\{\{ always\(\) && needs\.version\.result == 'success' && needs\.build-macos\.result == 'success' && needs\.build-windows\.result == 'success' \}\}/,
    );
  });

  it("publishes both manual and automatic releases draft-first, then undrafts", () => {
    // #599 made both workflows draft-first: create as a draft, upload with retry, undraft
    // last, so a run that dies mid-upload leaves an invisible draft rather than a published
    // release missing installers. The old assertion here was `not.toContain("--draft")`,
    // which turned into a false statement about what ships the moment that landed — and it
    // reddened main. What matters is not that the flag is absent but that the release is
    // never VISIBLE until its assets are attached, so assert the sequence instead.
    expect(releaseWorkflow).toContain('gh release create "$TAG" --verify-tag --draft --title');
    // auto-release wraps its flags across continuation lines, so the draft flag is matched
    // on its own line rather than inside the create command's text.
    expect(autoReleaseWorkflow).toMatch(/gh release create "\$TAG" \\\n\s+--draft \\/);

    // ORDER is the property, and neither `toContain` above can express it: a workflow that
    // undrafted FIRST and created a draft afterwards satisfies every membership assertion
    // while shipping the exact failure draft-first exists to prevent — a release visible
    // before its assets are attached. Positions can say it; membership cannot.
    //
    // (The assertion this replaces was `expect(autoReleaseWorkflow).toContain("--draft")`,
    // which no workflow satisfying the next line could ever fail: `--draft=false` contains
    // `--draft`. It read as a second check and was a restatement of the first.)
    for (const [name, workflow] of [
      ["release", releaseWorkflow],
      ["auto-release", autoReleaseWorkflow],
    ] as const) {
      const created = workflow.indexOf('gh release create "$TAG"');
      const undrafted = workflow.indexOf('gh release edit "$TAG" --draft=false');
      expect(created, `${name}: creates the release`).toBeGreaterThanOrEqual(0);
      expect(undrafted, `${name}: undrafts AFTER creating`).toBeGreaterThan(created);
    }
  });
});
