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

  it("creates a draft in the manual path and preserves the signed automatic path", () => {
    expect(releaseWorkflow).toContain('gh release create "$TAG" --verify-tag --draft');
    expect(autoReleaseWorkflow).toContain('gh release create "$TAG"');
  });
});
