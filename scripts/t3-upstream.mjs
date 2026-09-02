#!/usr/bin/env node
/**
 * T3 Code vendoring upkeep.
 *
 *   node scripts/t3-upstream.mjs assemble --to <sha> [--clone <path>]
 *   node scripts/t3-upstream.mjs inspect            [--clone <path>]
 *   node scripts/t3-upstream.mjs fold --to <sha>    [--clone <path>]
 *   node scripts/t3-upstream.mjs check-ledger
 *
 * `vendor/t3code/UPSTREAM.json` is the one source of truth: upstream repository,
 * the commit the snapshot was taken from, and the upstream-relative paths that
 * are vendored. The pristine snapshots live on the `t3-vendor` branch, one
 * commit per fold, each carrying an `Upstream-Commit:` trailer. The working
 * branch merges that branch, so folds are ordinary three-way merges and
 * conflicts appear only in files Rennet edited — and every one of those edits
 * must be listed in `vendor/t3code/PATCHES.md`.
 *
 * Nothing here runs Biome or any formatter over the vendored tree.
 *
 * Docs: docs/developing/concepts/t3code-vendoring.md
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

/**
 * Rennet-owned files inside the vendor prefix that the ledger never has to list:
 * the base record, the ledger, digests, Nx project files, and the
 * `tsconfig.rennet.json` variants that narrow a vendored typecheck to what
 * Rennet's workspace can resolve.
 */
const LEDGER_EXEMPT = [
  /^UPSTREAM\.json$/,
  /^PATCHES\.md$/,
  /^digests\//,
  /(^|\/)project\.json$/,
  /(^|\/)tsconfig\.rennet\.json$/,
];

export function git(args, { cwd, env, input, allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

const out = (args, opts) => git(args, opts).stdout.trim();

export function readUpstream(repoRoot, prefix = "vendor/t3code") {
  const file = join(repoRoot, prefix, "UPSTREAM.json");
  if (!existsSync(file)) {
    throw new Error(`${file} is missing; write it before running this command`);
  }
  const config = JSON.parse(readFileSync(file, "utf8"));
  for (const key of ["repository", "commit", "paths"]) {
    if (!config[key]) throw new Error(`${file}: missing "${key}"`);
  }
  return {
    vendorBranch: "t3-vendor",
    defaultBranch: "main",
    prefix,
    ...config,
  };
}

export function writeUpstream(repoRoot, config) {
  const { prefix, ...rest } = config;
  const file = join(repoRoot, prefix, "UPSTREAM.json");
  const ordered = {
    repository: rest.repository,
    commit: rest.commit,
    date: rest.date,
    defaultBranch: rest.defaultBranch,
    vendorBranch: rest.vendorBranch,
    paths: rest.paths,
  };
  writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`);
  return file;
}

/**
 * Parse PATCHES.md. Every table row whose first cell is a backticked path is a
 * ledger entry; the path is relative to the vendor prefix.
 */
export function readLedger(repoRoot, prefix) {
  const file = join(repoRoot, prefix, "PATCHES.md");
  if (!existsSync(file)) return new Map();
  const entries = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/.exec(line);
    if (!match) continue;
    const cells = match[2].split("|").map((cell) => cell.trim());
    entries.set(match[1], {
      reason: cells[0] ?? "",
      upstreamable: cells[1] ?? "",
      upstreamPr: cells[2] ?? "",
    });
  }
  return entries;
}

/**
 * Bring the upstream default branch into this repository's object store. With
 * `--clone`, prefer the clone's remote-tracking ref so a stale local branch in
 * the clone cannot hide new upstream commits; fall back to its local branch
 * for clones (and test fixtures) that have no remote.
 */
export function fetchUpstream(repoRoot, config, clone) {
  const source = clone ?? config.repository;
  const ref = `refs/t3-upstream/${config.defaultBranch}`;
  const candidates = clone
    ? [`refs/remotes/origin/${config.defaultBranch}`, `refs/heads/${config.defaultBranch}`]
    : [`refs/heads/${config.defaultBranch}`];
  let lastError;
  for (const candidate of candidates) {
    const result = git(["fetch", "--quiet", source, `+${candidate}:${ref}`], {
      cwd: repoRoot,
      allowFailure: true,
    });
    if (result.status === 0) return out(["rev-parse", ref], { cwd: repoRoot });
    lastError = result.stderr;
  }
  throw new Error(`could not fetch ${config.defaultBranch} from ${source}:\n${lastError}`);
}

function ensureCommit(repoRoot, sha, config, clone) {
  if (
    git(["cat-file", "-e", `${sha}^{commit}`], { cwd: repoRoot, allowFailure: true }).status === 0
  ) {
    return out(["rev-parse", `${sha}^{commit}`], { cwd: repoRoot });
  }
  fetchUpstream(repoRoot, config, clone);
  if (
    git(["cat-file", "-e", `${sha}^{commit}`], { cwd: repoRoot, allowFailure: true }).status !== 0
  ) {
    throw new Error(`upstream commit ${sha} is not reachable from ${config.defaultBranch}`);
  }
  return out(["rev-parse", `${sha}^{commit}`], { cwd: repoRoot });
}

export function vendorTip(repoRoot, config) {
  const local = git(["rev-parse", "--verify", "--quiet", `refs/heads/${config.vendorBranch}`], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (local.status === 0) return local.stdout.trim();
  const remote = git(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${config.vendorBranch}`],
    { cwd: repoRoot, allowFailure: true },
  );
  return remote.status === 0 ? remote.stdout.trim() : undefined;
}

/** The newest snapshot commit reachable from HEAD, by its trailer. */
export function snapshotAncestor(repoRoot) {
  const sha = out(["log", "-1", "--format=%H", "--grep=^Upstream-Commit: ", "HEAD"], {
    cwd: repoRoot,
  });
  return sha || undefined;
}

export function upstreamCommitOf(repoRoot, snapshotSha) {
  const body = out(["log", "-1", "--format=%B", snapshotSha], { cwd: repoRoot });
  return /^Upstream-Commit:\s*([0-9a-f]{40})/m.exec(body)?.[1];
}

/**
 * Build one pristine snapshot commit on the vendor branch from the selected
 * upstream paths at `sha`. Returns the new vendor commit.
 */
export function assemble(repoRoot, config, sha, { clone } = {}) {
  const full = ensureCommit(repoRoot, sha, config, clone);
  const indexDir = mkdtempSync(join(tmpdir(), "rennet-t3-index-"));
  const indexFile = join(indexDir, "index");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    for (const path of config.paths) {
      const spec = `${full}:${path}`;
      const type = git(["cat-file", "-t", spec], { cwd: repoRoot, allowFailure: true });
      if (type.status !== 0) {
        throw new Error(`upstream ${sha.slice(0, 7)} has no "${path}"; fix UPSTREAM.json paths`);
      }
      const target = posix.join(config.prefix, path);
      if (type.stdout.trim() === "tree") {
        git(["read-tree", `--prefix=${target}/`, spec], { cwd: repoRoot, env });
      } else {
        const mode = out(["ls-tree", full, "--", path], { cwd: repoRoot }).split(" ")[0];
        const blob = out(["rev-parse", spec], { cwd: repoRoot });
        git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${target}`], {
          cwd: repoRoot,
          env,
        });
      }
    }
    const tree = out(["write-tree"], { cwd: repoRoot, env });
    const parent = vendorTip(repoRoot, config);
    const date = out(["log", "-1", "--format=%cI", full], { cwd: repoRoot });
    const message = [
      `t3code: snapshot ${full.slice(0, 7)} (${date.slice(0, 10)})`,
      "",
      `Pristine copy of ${config.paths.length} upstream paths from ${config.repository}.`,
      "",
      `Upstream-Commit: ${full}`,
      `Upstream-Date: ${date}`,
    ].join("\n");
    const commitArgs = ["commit-tree", tree, "-m", message];
    if (parent) commitArgs.push("-p", parent);
    const commit = out(commitArgs, { cwd: repoRoot });
    git(["update-ref", `refs/heads/${config.vendorBranch}`, commit, parent ?? ""], {
      cwd: repoRoot,
    });
    return { commit: parent === commit ? parent : commit, upstream: full, date };
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

function areaOf(file, paths) {
  const hit = paths.find((path) => file === path || file.startsWith(`${path}/`));
  return hit ?? "(other)";
}

/**
 * Commits on the upstream default branch since the recorded base that touch a
 * vendored path, with the files each one touched and whether any is ledgered.
 */
export function inspectUpstream(repoRoot, config, { clone } = {}) {
  const tip = fetchUpstream(repoRoot, config, clone);
  const base = ensureCommit(repoRoot, config.commit, config, clone);
  const ledger = readLedger(repoRoot, config.prefix);
  const shas = out(["rev-list", "--reverse", `${base}..${tip}`, "--", ...config.paths], {
    cwd: repoRoot,
  })
    .split("\n")
    .filter(Boolean);
  const commits = shas.map((sha) => {
    const [subject, date] = out(["log", "-1", "--format=%s%n%cs", sha], { cwd: repoRoot }).split(
      "\n",
    );
    const files = out(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", sha, "--", ...config.paths],
      { cwd: repoRoot },
    )
      .split("\n")
      .filter(Boolean);
    const risky = files.filter((file) => ledger.has(file));
    return {
      sha,
      subject,
      date,
      files,
      risky,
      areas: [...new Set(files.map((f) => areaOf(f, config.paths)))],
    };
  });
  const workspaceDiff = out(
    ["diff", "--no-color", base, tip, "--", "pnpm-workspace.yaml", "package.json"],
    { cwd: repoRoot },
  );
  return { base, tip, commits, workspaceDiff };
}

export function renderDigest(config, report, today) {
  const lines = [
    `# T3 Code upstream digest, ${today}`,
    "",
    `Base: \`${report.base}\` (recorded in UPSTREAM.json)`,
    `Upstream ${config.defaultBranch}: \`${report.tip}\``,
    `Commits touching vendored paths: ${report.commits.length}`,
    `Conflict risk (touch a ledgered file): ${report.commits.filter((c) => c.risky.length).length}`,
    "",
  ];
  const byArea = new Map();
  for (const commit of report.commits) {
    for (const area of commit.areas) {
      if (!byArea.has(area)) byArea.set(area, []);
      byArea.get(area).push(commit);
    }
  }
  for (const area of config.paths
    .filter((p) => byArea.has(p))
    .concat(byArea.has("(other)") ? ["(other)"] : [])) {
    lines.push(`## ${area}`, "");
    for (const commit of byArea.get(area)) {
      const flag = commit.risky.length ? " **CONFLICT RISK**" : "";
      lines.push(`- \`${commit.sha.slice(0, 7)}\` ${commit.date} ${commit.subject}${flag}`);
      for (const file of commit.files.filter((f) => areaOf(f, config.paths) === area)) {
        lines.push(`  - ${file}${commit.risky.includes(file) ? " (ledgered)" : ""}`);
      }
    }
    lines.push("");
  }
  lines.push("## Workspace manifest changes (pnpm-workspace.yaml, package.json)", "");
  lines.push(
    report.workspaceDiff ? ["```diff", report.workspaceDiff, "```"].join("\n") : "None.",
    "",
  );
  return lines.join("\n");
}

/** Files under the vendor prefix that differ between the working tree and a snapshot. */
export function vendoredDiff(repoRoot, config, snapshotSha) {
  const status = out(["diff", "--name-status", snapshotSha, "--", config.prefix], {
    cwd: repoRoot,
  });
  const untracked = out(["ls-files", "--others", "--exclude-standard", "--", config.prefix], {
    cwd: repoRoot,
  });
  const rows = status
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [code, ...rest] = line.split("\t");
      return { status: code[0], file: rest[rest.length - 1] };
    });
  for (const file of untracked.split("\n").filter(Boolean)) rows.push({ status: "?", file });
  return rows.map((row) => ({ ...row, relative: posix.relative(config.prefix, row.file) }));
}

export function checkLedger(repoRoot, config) {
  const snapshot = snapshotAncestor(repoRoot) ?? vendorTip(repoRoot, config);
  if (!snapshot) {
    throw new Error(
      `no snapshot commit found: neither an Upstream-Commit ancestor of HEAD nor ${config.vendorBranch}`,
    );
  }
  const recorded = upstreamCommitOf(repoRoot, snapshot);
  const problems = [];
  if (recorded !== config.commit) {
    problems.push(
      `UPSTREAM.json records ${config.commit} but the snapshot ${snapshot.slice(0, 7)} was taken from ${recorded}`,
    );
  }
  const ledger = readLedger(repoRoot, config.prefix);
  const diff = vendoredDiff(repoRoot, config, snapshot).filter(
    (row) => !LEDGER_EXEMPT.some((re) => re.test(row.relative)),
  );
  const unlogged = diff.filter((row) => !ledger.has(row.relative));
  for (const row of unlogged) {
    problems.push(
      `${row.file} differs from the snapshot (${row.status}) and has no PATCHES.md entry`,
    );
  }
  const differing = new Set(diff.map((row) => row.relative));
  const stale = [...ledger.keys()].filter((file) => !differing.has(file));
  return { snapshot, problems, stale, checked: diff.length };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
      }
    }
  }
  return { command, options };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function main(argv, repoRoot = out(["rev-parse", "--show-toplevel"])) {
  const { command, options } = parseArgs(argv);
  const clone = options.clone ? resolve(options.clone) : undefined;

  switch (command) {
    case "assemble": {
      if (!options.to) throw new Error("assemble needs --to <upstream sha>");
      const config = readUpstream(repoRoot);
      const result = assemble(repoRoot, config, options.to, { clone });
      console.log(
        `${config.vendorBranch} -> ${result.commit.slice(0, 7)} (upstream ${result.upstream.slice(0, 7)}, ${result.date.slice(0, 10)})`,
      );
      return 0;
    }
    case "inspect": {
      const config = readUpstream(repoRoot);
      const report = inspectUpstream(repoRoot, config, { clone });
      const dir = join(repoRoot, config.prefix, "digests");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${today()}.md`);
      writeFileSync(file, renderDigest(config, report, today()));
      console.log(
        `${report.commits.length} upstream commits touch vendored paths since ${report.base.slice(0, 7)}; ${report.commits.filter((c) => c.risky.length).length} carry conflict risk`,
      );
      console.log(`digest: ${file}`);
      return 0;
    }
    case "fold": {
      if (!options.to) throw new Error("fold needs --to <upstream sha>");
      const config = readUpstream(repoRoot);
      if (out(["status", "--porcelain"], { cwd: repoRoot })) {
        throw new Error("fold needs a clean working tree");
      }
      const before = checkLedger(repoRoot, config);
      if (before.problems.length) {
        throw new Error(`ledger is not clean before the fold:\n  ${before.problems.join("\n  ")}`);
      }
      const snapshot = assemble(repoRoot, config, options.to, { clone });
      const merge = git(["merge", "--no-ff", "--no-commit", snapshot.commit], {
        cwd: repoRoot,
        allowFailure: true,
      });
      const next = { ...config, commit: snapshot.upstream, date: snapshot.date };
      const upstreamFile = writeUpstream(repoRoot, next);
      git(["add", "--", upstreamFile], { cwd: repoRoot });
      if (merge.status !== 0) {
        const conflicts = out(["diff", "--name-only", "--diff-filter=U"], { cwd: repoRoot })
          .split("\n")
          .filter(Boolean);
        const ledger = readLedger(repoRoot, config.prefix);
        console.error(`fold stopped: ${conflicts.length} conflict(s). Resolve, then git commit.`);
        for (const file of conflicts) {
          const entry = ledger.get(posix.relative(config.prefix, file));
          console.error(
            `  ${file}${entry ? `\n    ledger: ${entry.reason} [upstreamable: ${entry.upstreamable}] ${entry.upstreamPr}` : "\n    (not in PATCHES.md)"}`,
          );
        }
        return 1;
      }
      git(
        [
          "commit",
          "-m",
          `t3code: fold to ${snapshot.upstream.slice(0, 7)} (${snapshot.date.slice(0, 10)})`,
        ],
        { cwd: repoRoot },
      );
      console.log(`folded to ${snapshot.upstream.slice(0, 7)}; UPSTREAM.json updated`);
      return 0;
    }
    case "check-ledger": {
      const config = readUpstream(repoRoot);
      const result = checkLedger(repoRoot, config);
      for (const file of result.stale) {
        console.warn(
          `warning: PATCHES.md lists ${file} but it matches the snapshot; drop the entry`,
        );
      }
      if (result.problems.length) {
        console.error("t3code ledger check failed:");
        for (const problem of result.problems) console.error(`  ${problem}`);
        return 1;
      }
      console.log(
        `t3code ledger ok: ${result.checked} vendored file(s) differ from snapshot ${result.snapshot.slice(0, 7)}, all ledgered`,
      );
      return 0;
    }
    default:
      console.error(
        "usage: t3-upstream.mjs <assemble --to <sha> | inspect | fold --to <sha> | check-ledger> [--clone <path>]",
      );
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
