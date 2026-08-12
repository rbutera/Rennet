import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit } from "./git-range-diff";
import { discoverGitlinks, discoverWorkspaceScopes } from "./repo-composition-discovery";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text);
}

function repo(): { root: string; oid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-nested-discovery-"));
  scratch.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "packages/pnpm/package.json", '{"name":"pnpm-scope"}\n');
  write(root, "packages/pnpm/src/index.ts", "export const value = 1;\n");
  write(root, "nx/deep/project.json", '{"name":"nx-deep","root":"nx/deep"}\n');
  write(root, "Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n');
  write(root, "crates/rust/Cargo.toml", '[package]\nname = "rust"\nversion = "0.1.0"\n');
  write(root, "go.work", "go 1.22\nuse (\n  ./services/goapp\n)\n");
  write(root, "services/goapp/go.mod", "module example.test/goapp\n");
  write(root, "looks-like-a-package/index.ts", "export {};\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "workspace");
  return { root, oid: git(root, "rev-parse", "HEAD") };
}

describe("pinned composition discovery", () => {
  it("applies pnpm exclusions and does not promote nested packages beyond the declared glob", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-pnpm-scope-discovery-"));
    scratch.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n  - "!packages/excluded"\n');
    write(root, "packages/kept/package.json", '{"name":"kept"}\n');
    write(root, "packages/kept/fixture/package.json", '{"name":"fixture"}\n');
    write(root, "packages/excluded/package.json", '{"name":"excluded"}\n');
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "pnpm scopes");

    const scopes = await discoverWorkspaceScopes(execaGit, root, git(root, "rev-parse", "HEAD"));
    expect(scopes).toEqual([{ name: "packages/kept", root: "packages/kept", provenance: "pnpm" }]);
  });

  it("discovers pnpm, Nx, Cargo, and go.work declarations without folder inference", async () => {
    const { root, oid } = repo();
    const scopes = await discoverWorkspaceScopes(execaGit, root, oid);
    expect(scopes.map((scope) => [scope.root, scope.provenance])).toEqual([
      ["packages/pnpm", "pnpm"],
      ["nx/deep", "nx"],
      ["crates/rust", "cargo"],
      ["services/goapp", "go-work"],
    ]);
    expect(scopes.some((scope) => scope.root.includes("looks-like"))).toBe(false);
  });

  it("uses the parent tree gitlink OID rather than any child checkout", async () => {
    const { root } = repo();
    write(
      root,
      ".gitmodules",
      '[submodule "tool"]\n\tpath = vendor/tool\n\turl = https://example.test/tool.git\n',
    );
    git(root, "add", ".gitmodules");
    const gitlinkOid = "1234567890123456789012345678901234567890";
    git(root, "update-index", "--add", "--cacheinfo", `160000,${gitlinkOid},vendor/tool`);
    git(root, "commit", "-q", "-m", "gitlink");
    const parentOid = git(root, "rev-parse", "HEAD");

    const links = await discoverGitlinks(execaGit, root, "parent", parentOid);
    expect(links).toEqual([
      {
        path: "vendor/tool",
        oid: gitlinkOid,
        repoRecordId: "parent:vendor/tool",
        name: "tool",
        url: "https://example.test/tool.git",
      },
    ]);
  });
});
