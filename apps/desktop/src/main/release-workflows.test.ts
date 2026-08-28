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

  it("publishes both manual and automatic releases — draft first, undrafted last", () => {
    // #599 made both workflows draft-first to survive the asset-upload propagation race:
    // create as a draft, upload with retry, undraft only once the assets are really there.
    // So "published" is no longer "never a draft" — it is "does not STAY a draft", and the
    // undraft is the assertion that matters. (This test still forbade `--draft` after #599
    // landed the flag, so it was red on main; the rule it encodes is what changed, not the
    // intent — a release must end up visible.)
    expect(releaseWorkflow).toContain('gh release create "$TAG" --verify-tag --draft --title');
    expect(releaseWorkflow).toContain('gh release edit "$TAG" --draft=false');
    expect(autoReleaseWorkflow).toContain('gh release create "$TAG"');
    expect(autoReleaseWorkflow).toContain('gh release edit "$TAG" --draft=false');
  });
});
