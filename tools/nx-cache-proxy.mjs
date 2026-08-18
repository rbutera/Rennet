#!/usr/bin/env node

// Nx self-hosted remote cache proxy for CI.
//
// A lightweight HTTP server implementing Nx's remote cache OpenAPI spec
// (PUT/GET /v1/cache/{hash}). Backed by a local directory that GitHub
// Actions' actions/cache persists across runs. When Nx sees a remote cache
// via NX_SELF_HOSTED_REMOTE_CACHE_SERVER, it bypasses the local DB sync
// check that makes actions/cache-based .nx/ caching impossible on Nx 23+.
//
// Usage:
//   node tools/nx-cache-proxy.mjs
//
// Environment:
//   NX_CACHE_PROXY_PORT  (default: 4210)
//   NX_CACHE_PROXY_DIR   (default: /tmp/nx-remote-cache)
//   NX_CACHE_PROXY_MAX_MB (default: 500 — evicts oldest entries above this)

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const PORT = parseInt(process.env.NX_CACHE_PROXY_PORT || "4210", 10);
const CACHE_DIR = process.env.NX_CACHE_PROXY_DIR || "/tmp/nx-remote-cache";
const MAX_BYTES = parseInt(process.env.NX_CACHE_PROXY_MAX_MB || "500", 10) * 1024 * 1024;

mkdirSync(CACHE_DIR, { recursive: true });

function hashFromUrl(url) {
  const match = url.match(/^\/v1\/cache\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

function tarPath(hash) {
  return join(CACHE_DIR, `${hash}.tar`);
}

function evictOldest() {
  const entries = readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith(".tar"))
    .map((f) => {
      const full = join(CACHE_DIR, f);
      const stat = statSync(full);
      return { path: full, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let total = entries.reduce((sum, e) => sum + e.size, 0);
  let evicted = 0;
  while (total > MAX_BYTES && entries.length > 0) {
    const oldest = entries.shift();
    try {
      unlinkSync(oldest.path);
      total -= oldest.size;
      evicted++;
    } catch {
      // best-effort
    }
  }
  if (evicted > 0) {
    console.log(
      `Evicted ${evicted} old cache entries (${(total / 1024 / 1024).toFixed(1)} MB remaining)`,
    );
  }
}

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  const hash = hashFromUrl(req.url);

  if (!hash) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad request: expected /v1/cache/{hash}");
    return;
  }

  if (req.method === "GET") {
    const path = tarPath(hash);
    if (!existsSync(path)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const stat = statSync(path);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
    });
    createReadStream(path).pipe(res);
    return;
  }

  if (req.method === "PUT") {
    const path = tarPath(hash);
    if (existsSync(path)) {
      // Already cached — idempotent, skip the write.
      res.writeHead(200);
      res.end();
      req.resume();
      return;
    }
    const tmp = `${path}.${process.pid}.tmp`;
    const ws = createWriteStream(tmp);
    req.pipe(ws);
    ws.on("finish", () => {
      try {
        renameSync(tmp, path);
      } catch {
        // fall through — tmp is cleaned up on next eviction
      }
      evictOldest();
      res.writeHead(201);
      res.end();
    });
    ws.on("error", (err) => {
      console.error(`Write failed for ${hash}:`, err.message);
      res.writeHead(500);
      res.end();
    });
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method not allowed");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`nx-cache-proxy listening on http://127.0.0.1:${PORT} (dir: ${CACHE_DIR})`);
});
