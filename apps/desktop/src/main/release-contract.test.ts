import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const checkScript = resolve(import.meta.dirname, "../../../../scripts/check-release.mjs");
const roots: string[] = [];

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function releaseRepo(version: string, tag = `v${version}`): string {
  const root = mkdtempSync(resolve(tmpdir(), "rennet-release-contract-"));
  roots.push(root);
  mkdirSync(resolve(root, "apps/desktop"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify({ version })}\n`);
  writeFileSync(resolve(root, "apps/desktop/package.json"), `${JSON.stringify({ version })}\n`);
  git(root, "init");
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "user.email", "release-test@example.com");
  git(root, "add", ".");
  git(root, "commit", "-m", "release fixture");
  git(root, "tag", tag);
  return root;
}

function check(root: string, tag: string) {
  return spawnSync(process.execPath, [checkScript, tag], { cwd: root, encoding: "utf8" });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release contract", () => {
  it("accepts a clean tagged checkout whose root and desktop versions match", () => {
    const result = check(releaseRepo("1.2.3"), "v1.2.3");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("v1.2.3 is ready");
  });

  it.each([
    ["zero version", "0.0.0", "v0.0.0", "0.0.0 cannot be released"],
    ["tag mismatch", "1.2.3", "v1.2.4", "does not match package version"],
    ["malformed tag", "1.2.3", "1.2.3", "expected a tag shaped vX.Y.Z"],
  ])("rejects %s", (_case, version, tag, expected) => {
    const result = check(releaseRepo(version, tag), tag);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
  });

  it("rejects mismatched package versions and a dirty tree", () => {
    const mismatched = releaseRepo("1.2.3");
    writeFileSync(
      resolve(mismatched, "apps/desktop/package.json"),
      `${JSON.stringify({ version: "1.2.4" })}\n`,
    );
    let result = check(mismatched, "v1.2.3");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package versions differ");

    const dirty = releaseRepo("2.0.0");
    writeFileSync(resolve(dirty, "untracked.txt"), "dirty\n");
    result = check(dirty, "v2.0.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("working tree is dirty");
  });
});
