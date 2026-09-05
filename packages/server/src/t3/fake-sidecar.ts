// A stand-in for the vendored T3 server, shared by the sidecar's own tests and the
// supervisor's. It is not a `.test.ts` file because two suites need it; nothing outside a
// test imports it.

/**
 * A stand-in for the vendored T3 server that honours the same parent contract: reads
 * the bootstrap envelope from fd 3, listens on the envelope's port, writes
 * `userdata/server-runtime.json` once bound, answers the well-known probe, exchanges
 * the bootstrap token at `/oauth/token`, checks bearers on `/api/auth/websocket-ticket`,
 * and exits on SIGTERM. It also dumps its argv and env so a test can prove no credential
 * travelled that way. `FAKE_T3_IGNORE_SIGTERM=1` makes it refuse to die.
 */
export const FAKE_SIDECAR = `
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
// Read the pipe by descriptor number: /dev/fd/3 is not readable as a path on every Linux.
const line = fs.readFileSync(3, "utf8").split("\\n")[0];
const envelope = JSON.parse(line);
const home = envelope.t3Home;
fs.mkdirSync(path.join(home, "userdata"), { recursive: true });
fs.writeFileSync(path.join(home, "fake-spawn.json"), JSON.stringify({ argv: process.argv, env: process.env, envelope }));
const access = "access-" + Math.random().toString(36).slice(2);
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.url === "/.well-known/t3/environment") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ environmentId: "env-1", label: "fake", platform: "darwin", serverVersion: "0.0.38", capabilities: [] }));
      return;
    }
    if (req.url === "/oauth/token" && req.method === "POST") {
      const form = new URLSearchParams(body);
      if (form.get("subject_token") !== envelope.desktopBootstrapToken || form.get("subject_token_type") !== "urn:t3:params:oauth:token-type:environment-bootstrap") {
        res.writeHead(401); res.end("{}"); return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: access, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 2592000, scope: "orchestration:read" }));
      return;
    }
    if (req.url === "/api/auth/websocket-ticket" && req.method === "POST") {
      const ok = req.headers.authorization === "Bearer " + access;
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { ticket: "t", expiresAt: "x" } : {}));
      return;
    }
    res.writeHead(404); res.end();
  });
});
server.listen(envelope.port, envelope.host, () => {
  const runtime = path.join(home, "userdata", "server-runtime.json");
  fs.writeFileSync(runtime, JSON.stringify({ version: 1, pid: process.pid, host: envelope.host, port: envelope.port, origin: "http://" + envelope.host + ":" + envelope.port, startedAt: new Date().toISOString() }) + "\\n");
  process.on("SIGTERM", () => {
    if (process.env.FAKE_T3_IGNORE_SIGTERM === "1") return;
    try { fs.unlinkSync(runtime); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 200).unref();
  });
});
`;
