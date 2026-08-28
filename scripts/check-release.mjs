#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  console.error(`release-check: ${message}`);
  process.exit(1);
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    fail(`git ${args.join(" ")} failed`);
  }
}

function packageVersion(path) {
  try {
    const value = JSON.parse(readFileSync(resolve(path), "utf8")).version;
    if (typeof value !== "string") fail(`${path} has no string version`);
    return value;
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const requestedTag = process.argv[2] ?? git(["describe", "--tags", "--exact-match", "HEAD"]);
const match = SEMVER_TAG.exec(requestedTag);
if (!match) fail(`expected a tag shaped vX.Y.Z, got ${requestedTag}`);

const version = match.slice(1).join(".");
if (version === "0.0.0") fail("0.0.0 cannot be released");

const rootVersion = packageVersion("package.json");
const desktopVersion = packageVersion("apps/desktop/package.json");
if (rootVersion !== desktopVersion) {
  fail(`package versions differ: root=${rootVersion}, desktop=${desktopVersion}`);
}
if (version !== rootVersion)
  fail(`tag ${requestedTag} does not match package version ${rootVersion}`);

const tagCommit = git(["rev-list", "-n", "1", requestedTag]);
const headCommit = git(["rev-parse", "HEAD"]);
if (tagCommit !== headCommit) fail(`tag ${requestedTag} does not point at HEAD`);

if (git(["status", "--porcelain=v1", "--untracked-files=all"])) {
  fail("working tree is dirty");
}

console.log(`release-check: ${requestedTag} is ready`);
