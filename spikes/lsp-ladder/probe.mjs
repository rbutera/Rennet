import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

const [rootPath, relativeFile, lineText] = process.argv.slice(2);
if (!rootPath || !relativeFile || !lineText) {
  throw new Error("usage: node probe.mjs <root> <relative-file> <line-substring>");
}

const absoluteFile = resolve(rootPath, relativeFile);
const lines = readFileSync(absoluteFile, "utf8").split("\n");
const line = lines.findIndex((value) => value.includes(lineText));
if (line < 0) throw new Error(`positive-control text not found: ${lineText}`);
const character = lines[line].indexOf(lineText) + Math.max(0, lineText.lastIndexOf(".") + 1);
const uri = pathToFileURL(absoluteFile).href;
const rootUri = pathToFileURL(resolve(rootPath)).href;
const startedAt = performance.now();
const child = spawn(resolve("node_modules/.bin/tsgo"), ["--lsp", "--stdio"], {
  cwd: rootPath,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
const diagnostics = [];
let stderr = "";

child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString();
    const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
    if (!Number.isFinite(length)) throw new Error(`invalid LSP header: ${header}`);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString());
    buffer = buffer.subarray(bodyStart + length);
    if (message.id && pending.has(message.id)) {
      const { resolve: resolveRequest, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolveRequest(message.result);
    } else if (message.id && message.method) {
      const result = message.method === "workspace/configuration"
        ? (message.params?.items ?? []).map(() => ({}))
        : null;
      send({ jsonrpc: "2.0", id: message.id, result });
    } else if (message.method === "textDocument/publishDiagnostics") {
      diagnostics.push(message.params);
    }
  }
});

function send(message) {
  const body = JSON.stringify(message);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function request(method, params, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function rssMb(pid) {
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  return Number(result.stdout.trim()) / 1024;
}

try {
  const initialize = await request("initialize", {
    processId: process.pid,
    rootUri,
    capabilities: {},
    workspaceFolders: [{ uri: rootUri, name: "fixture" }],
  });
  const initializeMs = performance.now() - startedAt;
  notify("initialized", {});
  notify("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "typescript",
      version: 1,
      text: readFileSync(absoluteFile, "utf8"),
    },
  });

  const position = { line, character };
  const requestStartedAt = performance.now();
  const hover = await request("textDocument/hover", { textDocument: { uri }, position });
  const hoverMs = performance.now() - requestStartedAt;
  const definition = await request("textDocument/definition", { textDocument: { uri }, position });
  const references = await request("textDocument/references", {
    textDocument: { uri },
    position,
    context: { includeDeclaration: true },
  });
  const rename = await request("textDocument/prepareRename", { textDocument: { uri }, position });
  const rss = rssMb(child.pid);

  console.log(JSON.stringify({
    tsgoVersion: spawnSync(resolve("node_modules/.bin/tsgo"), ["--version"], { encoding: "utf8" }).stdout.trim(),
    fixture: { rootPath, relativeFile, line: line + 1, character, positiveControl: lineText },
    initializeMs: Math.round(initializeMs * 100) / 100,
    firstHoverMs: Math.round(hoverMs * 100) / 100,
    rssMb: Math.round(rss * 100) / 100,
    capabilities: {
      hover: Boolean(initialize.capabilities?.hoverProvider),
      definition: Boolean(initialize.capabilities?.definitionProvider),
      references: Boolean(initialize.capabilities?.referencesProvider),
      rename: Boolean(initialize.capabilities?.renameProvider),
    },
    positiveControls: {
      hover: Boolean(hover),
      definitionLocations: Array.isArray(definition) ? definition.length : definition ? 1 : 0,
      referenceLocations: Array.isArray(references) ? references.length : 0,
      prepareRename: Boolean(rename),
    },
    diagnosticsPublished: diagnostics.length,
  }, null, 2));
} finally {
  try {
    await request("shutdown", null, 5000);
    notify("exit", null);
  } catch {
    child.kill("SIGKILL");
  }
}

if (stderr.trim()) process.stderr.write(stderr);
