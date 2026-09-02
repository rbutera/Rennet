import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  assemble,
  checkLedger,
  git,
  inspectUpstream,
  main,
  readUpstream,
  writeUpstream,
} from "./t3-upstream.mjs";

const cleanups = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), `rennet-t3-${name}-`));
  cleanups.push(dir);
  git(["init", "--quiet", "-b", "main", dir]);
  git(["config", "user.name", "t"], { cwd: dir });
  git(["config", "user.email", "t@example.com"], { cwd: dir });
  return dir;
}

function commitAll(dir, message) {
  git(["add", "-A"], { cwd: dir });
  git(["commit", "--quiet", "-m", message], { cwd: dir });
  return git(["rev-parse", "HEAD"], { cwd: dir }).stdout.trim();
}

function put(dir, file, content) {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
}

/** An upstream with two vendored paths and one path that is not vendored. */
function fixture() {
  const upstream = tempRepo("upstream");
  put(upstream, "LICENSE", "MIT\n");
  put(upstream, "packages/contracts/src/index.ts", "export const a = 1;\n");
  put(upstream, "apps/server/src/bin.ts", "console.log('serve');\n");
  put(upstream, "apps/mobile/ignored.ts", "not vendored\n");
  const base = commitAll(upstream, "upstream base");

  const repo = tempRepo("consumer");
  put(repo, "README.md", "rennet\n");
  mkdirSync(join(repo, "vendor/t3code"), { recursive: true });
  put(
    repo,
    "vendor/t3code/PATCHES.md",
    "| File | Reason | Upstreamable | Upstream PR |\n| --- | --- | --- | --- |\n",
  );
  writeUpstream(repo, {
    prefix: "vendor/t3code",
    repository: upstream,
    commit: base,
    date: "2026-01-01T00:00:00Z",
    defaultBranch: "main",
    vendorBranch: "t3-vendor",
    paths: ["LICENSE", "packages/contracts", "apps/server"],
  });
  commitAll(repo, "config");
  return { upstream, repo, base };
}

function mergeVendor(repo, commit) {
  git(["merge", "--quiet", "--allow-unrelated-histories", "--no-edit", commit], { cwd: repo });
}

describe("assemble", () => {
  it("builds the vendor branch from only the selected paths, under the prefix", () => {
    const { repo, base } = fixture();
    const config = readUpstream(repo);
    const result = assemble(repo, config, base, { clone: config.repository });
    const files = git(["ls-tree", "-r", "--name-only", result.commit], { cwd: repo })
      .stdout.trim()
      .split("\n");
    assert.deepEqual(files, [
      "vendor/t3code/LICENSE",
      "vendor/t3code/apps/server/src/bin.ts",
      "vendor/t3code/packages/contracts/src/index.ts",
    ]);
    const body = git(["log", "-1", "--format=%B", result.commit], { cwd: repo }).stdout;
    assert.match(body, new RegExp(`Upstream-Commit: ${base}`));
    assert.equal(git(["rev-parse", "t3-vendor"], { cwd: repo }).stdout.trim(), result.commit);
  });

  it("refuses a path the upstream commit does not have", () => {
    const { repo, base } = fixture();
    const config = { ...readUpstream(repo), paths: ["LICENSE", "does/not/exist"] };
    assert.throws(
      () => assemble(repo, config, base, { clone: config.repository }),
      /does\/not\/exist/,
    );
  });
});

describe("check-ledger", () => {
  it("passes when nothing under the prefix differs from the snapshot", () => {
    const { repo, base } = fixture();
    const config = readUpstream(repo);
    const snap = assemble(repo, config, base, { clone: config.repository });
    mergeVendor(repo, snap.commit);
    const result = checkLedger(repo, config);
    assert.deepEqual(result.problems, []);
    assert.equal(result.snapshot, snap.commit);
  });

  it("fails naming an edited vendored file that has no ledger row", () => {
    const { repo, base } = fixture();
    const config = readUpstream(repo);
    mergeVendor(repo, assemble(repo, config, base, { clone: config.repository }).commit);
    put(repo, "vendor/t3code/apps/server/src/bin.ts", "console.log('edited');\n");
    const result = checkLedger(repo, config);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /vendor\/t3code\/apps\/server\/src\/bin\.ts/);
    // Positive control for the exemptions: Rennet-owned files never need a row.
    put(repo, "vendor/t3code/apps/server/project.json", "{}\n");
    put(repo, "vendor/t3code/digests/2026-01-02.md", "# digest\n");
    assert.equal(checkLedger(repo, config).problems.length, 1);
  });

  it("passes once the edit is ledgered, and reports a stale row", () => {
    const { repo, base } = fixture();
    const config = readUpstream(repo);
    mergeVendor(repo, assemble(repo, config, base, { clone: config.repository }).commit);
    put(repo, "vendor/t3code/apps/server/src/bin.ts", "console.log('edited');\n");
    put(
      repo,
      "vendor/t3code/PATCHES.md",
      [
        "| File | Reason | Upstreamable | Upstream PR |",
        "| --- | --- | --- | --- |",
        "| `apps/server/src/bin.ts` | outputFormat option | yes | |",
        "| `packages/contracts/src/index.ts` | old entry | no | |",
        "",
      ].join("\n"),
    );
    const result = checkLedger(repo, config);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.stale, ["packages/contracts/src/index.ts"]);
  });

  it("fails when UPSTREAM.json and the snapshot disagree about the base", () => {
    const { repo, base } = fixture();
    const config = readUpstream(repo);
    mergeVendor(repo, assemble(repo, config, base, { clone: config.repository }).commit);
    writeUpstream(repo, { ...config, commit: "0".repeat(40) });
    const result = checkLedger(repo, readUpstream(repo));
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /records 0{40}/);
  });
});

describe("inspect and fold", () => {
  function advanceUpstream(upstream) {
    put(upstream, "packages/contracts/src/index.ts", "export const a = 2;\n");
    commitAll(upstream, "contracts: bump a");
    put(upstream, "apps/server/src/bin.ts", "console.log('serve v2');\n");
    commitAll(upstream, "server: v2 banner");
    put(upstream, "apps/mobile/ignored.ts", "still not vendored\n");
    commitAll(upstream, "mobile: ignored change");
    return git(["rev-parse", "HEAD"], { cwd: upstream }).stdout.trim();
  }

  it("inspect lists only commits touching vendored paths and marks ledgered files as risk", () => {
    const { upstream, repo, base } = fixture();
    const config = readUpstream(repo);
    mergeVendor(repo, assemble(repo, config, base, { clone: upstream }).commit);
    put(repo, "vendor/t3code/apps/server/src/bin.ts", "console.log('rennet');\n");
    put(
      repo,
      "vendor/t3code/PATCHES.md",
      "| File | Reason | Upstreamable | Upstream PR |\n| --- | --- | --- | --- |\n| `apps/server/src/bin.ts` | banner | no | |\n",
    );
    commitAll(repo, "local edit");
    const tip = advanceUpstream(upstream);

    const report = inspectUpstream(repo, config, { clone: upstream });
    assert.equal(report.tip, tip);
    assert.deepEqual(
      report.commits.map((c) => [c.subject, c.risky.length > 0]),
      [
        ["contracts: bump a", false],
        ["server: v2 banner", true],
      ],
    );

    const code = main(["inspect", "--clone", upstream], repo);
    assert.equal(code, 0);
    const digest = readFileSync(
      join(repo, "vendor/t3code/digests", `${new Date().toISOString().slice(0, 10)}.md`),
      "utf8",
    );
    assert.match(digest, /server: v2 banner \*\*CONFLICT RISK\*\*/);
    assert.match(digest, /contracts: bump a$/m);
    assert.doesNotMatch(digest, /mobile: ignored change/);
  });

  it("fold merges untouched files cleanly and updates the recorded base", () => {
    const { upstream, repo, base } = fixture();
    const config = readUpstream(repo);
    mergeVendor(repo, assemble(repo, config, base, { clone: upstream }).commit);
    const tip = advanceUpstream(upstream);

    const code = main(["fold", "--to", tip, "--clone", upstream], repo);
    assert.equal(code, 0);
    assert.equal(readUpstream(repo).commit, tip);
    assert.equal(
      readFileSync(join(repo, "vendor/t3code/packages/contracts/src/index.ts"), "utf8"),
      "export const a = 2;\n",
    );
    assert.equal(git(["status", "--porcelain"], { cwd: repo }).stdout.trim(), "");
    assert.deepEqual(checkLedger(repo, readUpstream(repo)).problems, []);
  });

  it("fold stops on a ledgered file upstream also changed, with the ledger entry printed", () => {
    const { upstream, repo, base } = fixture();
    const config = readUpstream(repo);
    mergeVendor(repo, assemble(repo, config, base, { clone: upstream }).commit);
    put(repo, "vendor/t3code/apps/server/src/bin.ts", "console.log('rennet');\n");
    put(
      repo,
      "vendor/t3code/PATCHES.md",
      "| File | Reason | Upstreamable | Upstream PR |\n| --- | --- | --- | --- |\n| `apps/server/src/bin.ts` | banner | no | |\n",
    );
    commitAll(repo, "local edit");
    const tip = advanceUpstream(upstream);

    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    let code;
    try {
      code = main(["fold", "--to", tip, "--clone", upstream], repo);
    } finally {
      console.error = original;
    }
    assert.equal(code, 1);
    const conflicted = git(["diff", "--name-only", "--diff-filter=U"], { cwd: repo }).stdout.trim();
    assert.equal(conflicted, "vendor/t3code/apps/server/src/bin.ts");
    assert.ok(errors.some((line) => line.includes("ledger: banner")));
    // The untouched file still folded, and the base is staged for the resolving commit.
    assert.equal(
      readFileSync(join(repo, "vendor/t3code/packages/contracts/src/index.ts"), "utf8"),
      "export const a = 2;\n",
    );
    assert.equal(readUpstream(repo).commit, tip);
  });
});
