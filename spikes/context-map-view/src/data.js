// Model over the REAL exported Repo Map (rennet-map.json, minted by `rennet map`),
// plus the STAGED parts of the spike: knowledge claims, primer sections, chat script.
import raw from "../rennet-map.json";

export const meta = {
  repoKey: raw.repoKey,
  baseRef: raw.baseRef,
  baseOid: raw.baseOid,
  fingerprint: raw.fingerprint,
  fileCount: raw.map.files.length,
  scopeCount: raw.map.scopes.length,
  edgeCount: raw.map.edges.length,
  testCount: raw.map.tests.length,
};

export const symbolsByFile = raw.symbols;
export const conventions = raw.map.conventions;

function makeDir(name, path) {
  return { name, path, dirs: [], files: [], fileCount: 0 };
}

function insertFile(scopeNode, relPath, file) {
  const parts = relPath.split("/");
  let node = scopeNode;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    let child = node.dirs.find((dir) => dir.name === part);
    if (!child) {
      child = makeDir(part, node.path ? `${node.path}/${part}` : part);
      node.dirs.push(child);
    }
    node = child;
  }
  node.files.push(file);
}

function rollUp(node) {
  let count = node.files.length;
  for (const dir of node.dirs) count += rollUp(dir);
  node.fileCount = count;
  node.dirs.sort((a, b) => a.name.localeCompare(b.name));
  node.files.sort((a, b) => a.path.localeCompare(b.path));
  return count;
}

export function buildModel() {
  const scopes = raw.map.scopes.map((scope) => ({
    name: scope.name,
    root: scope.root,
    tree: makeDir(scope.name, scope.root),
    out: raw.map.edges.filter((edge) => edge.from === scope.name).map((edge) => edge.to),
    in: raw.map.edges.filter((edge) => edge.to === scope.name).map((edge) => edge.from),
    entry: raw.map.entryPoints.find((entry) => entry.scope === scope.name),
    testCount: 0,
  }));
  const rootScope = {
    name: "(repo root)",
    root: "",
    tree: makeDir("(repo root)", ""),
    out: [],
    in: [],
    entry: undefined,
    testCount: 0,
  };
  const byDepth = [...scopes].sort((a, b) => b.root.length - a.root.length);
  const owner = (path) =>
    byDepth.find((scope) => path === scope.root || path.startsWith(`${scope.root}/`)) ?? rootScope;
  for (const file of raw.map.files) {
    const scope = owner(file.path);
    const rel = scope.root ? file.path.slice(scope.root.length + 1) : file.path;
    insertFile(scope.tree, rel, file);
  }
  for (const test of raw.map.tests) owner(test.path ?? test).testCount++;
  const all = [...scopes.sort((a, b) => a.name.localeCompare(b.name)), rootScope];
  for (const scope of all) rollUp(scope.tree);
  return all;
}

// ---- STAGED: knowledge-layer claims -------------------------------------------------
// Real ones are minted by the model-backed enrichment pass (knowledge-generation.ts)
// with provenance + confidence; these are handcrafted to exercise every state.
export const seedClaims = [
  {
    id: "k1",
    subject: "@rennet/core",
    aspect: "purpose",
    claim:
      "Owns the pure review domain: canvas ops, the orchestrator session, snapshot building and every project-context query. Browser-safe by construction — no Node APIs cross this boundary.",
    confidence: "high",
    evidence: ["packages/core/src/index.ts", "packages/core/src/project-context.ts"],
    provenance: { generator: "knowledge-pass@1", model: "claude" },
    state: "hypothesis",
  },
  {
    id: "k2",
    subject: "@rennet/adapters",
    aspect: "purpose",
    claim:
      "The Node-facing shell around core: git execution, snapshot generation and the on-disk project store. Anything that touches a real filesystem or process lives here, not in core.",
    confidence: "high",
    evidence: ["packages/adapters/src/project-snapshot-generator.ts"],
    provenance: { generator: "knowledge-pass@1", model: "claude" },
    state: "confirmed",
  },
  {
    id: "k3",
    subject: "@rennet/ui",
    aspect: "constraint",
    claim:
      "Deliberately cut off from core: it may import only types, protocol and theme, so every review fact it renders must arrive over the protocol rather than by reaching into domain logic.",
    confidence: "medium",
    evidence: ["packages/ui/package.json"],
    provenance: { generator: "knowledge-pass@1", model: "claude" },
    state: "hypothesis",
  },
  {
    id: "k4",
    subject: "packages/core/src/project-context.ts",
    aspect: "role",
    claim:
      "The read side of the Repo Map: materializes a snapshot from content-addressed shards and answers every map/overview/symbol/reference query the orchestrator's context.* tools expose.",
    confidence: "high",
    evidence: ["packages/core/src/project-context.ts"],
    provenance: { generator: "knowledge-pass@1", model: "claude" },
    state: "hypothesis",
  },
  {
    id: "k5",
    subject: "@rennet/server",
    aspect: "purpose",
    claim: "A thin HTTP facade that proxies GitHub API calls for the desktop app.",
    confidence: "low",
    evidence: ["packages/server/src/create-server.ts"],
    provenance: { generator: "knowledge-pass@1", model: "claude" },
    state: "rejected",
  },
];

// ---- STAGED: the primer (real one is deterministic, versioned, 4096-byte ceiling) ---
export const primerSections = [
  {
    name: "Identity",
    bytes: 214,
    body: `repo ${meta.repoKey}\nbase ${meta.baseRef} @ ${meta.baseOid.slice(0, 12)}\nfingerprint ${meta.fingerprint.slice(0, 16)}…`,
  },
  { name: "Freshness", bytes: 96, body: "map current · knowledge current · built from base tip" },
  {
    name: "Canvas summary",
    bytes: 342,
    body: `${meta.scopeCount} scopes · ${meta.fileCount} files · ${meta.edgeCount} scope edges · ${meta.testCount} test files`,
  },
  {
    name: "Protocol card",
    bytes: 388,
    body: "canvasOps@2 · envelope { data, evidence, freshness, total, cursor, truncated }",
  },
  {
    name: "Tool index",
    bytes: 512,
    body: "context.map · context.file · context.overview · context.symbol · context.references · context.novelty · context.knowledge · context.ask",
  },
  { name: "Run headline", bytes: 120, body: "no run evidence attached to this surface" },
];
export const primerBudget = 4096;

// ---- STAGED: the conversation (real one is a project-scoped orchestrator session) ---
export const seedChat = [
  { id: "m1", role: "user", text: "What am I looking at?" },
  {
    id: "m2",
    role: "orchestrator",
    tools: ["context.map"],
    text: `rennet at ${meta.baseRef} @ ${meta.baseOid.slice(0, 7)} — ${meta.scopeCount} workspace scopes, ${meta.fileCount.toLocaleString()} files. The domain heart is @rennet/core; @rennet/adapters wraps it for Node; @rennet/ui renders over the protocol only.`,
  },
  { id: "m3", role: "user", text: "Why doesn't ui import core?" },
  {
    id: "m4",
    role: "orchestrator",
    tools: ["context.map", "context.references"],
    text: "By boundary contract: ui may import only types, protocol and theme. Every fact it renders must cross the protocol, which keeps the browser bundle free of domain logic and Node dependencies. The dependency edges confirm no ui → core edge exists.",
  },
];

export function discussScript(claim) {
  return [
    {
      id: crypto.randomUUID(),
      role: "user",
      text: `This claim about ${claim.subject} doesn't look right — revise it.`,
    },
    {
      id: crypto.randomUUID(),
      role: "orchestrator",
      tools: ["context.knowledge", "context.ask"],
      text: `Re-examined against the evidence. Revised hypothesis for ${claim.subject}: the previous statement overreached; I have narrowed it and lowered confidence until a human confirms. (Scripted — the real view mints a new labelled statement with fresh provenance.)`,
    },
  ];
}

export function cannedReply() {
  return {
    id: crypto.randomUUID(),
    role: "orchestrator",
    tools: ["context.ask"],
    text: "Scripted spike: in the production view this message goes to a project-scoped orchestrator session speaking the context.* tools over canvasOps@2.",
  };
}
