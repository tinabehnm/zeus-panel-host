/**
 * ZEUS Panel — Node.js host adapter
 * -----------------------------------
 * Runs the UNMODIFIED ZEUS Cloudflare Worker (Source.js) on the real
 * open-source Cloudflare Workers runtime (workerd) via Miniflare, with a
 * local persistent D1 (SQLite) database. A fixed-port HTTP + WebSocket
 * reverse proxy exposes the worker — same architecture as `wrangler dev`.
 *
 * Env vars:
 *   PORT   — HTTP port (default 3000). MS HOST sets this automatically.
 *   HOST   — bind address (default 0.0.0.0).
 */
import { Miniflare } from "miniflare";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
// ZEUS_DATA lets hosts with a persistent volume mount (e.g. /data) keep the
// D1 database across redeploys. Falls back to ./.zeus-data next to this file.
const DATA_DIR = process.env.ZEUS_DATA ? path.resolve(process.env.ZEUS_DATA) : path.join(__dirname, ".zeus-data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const scriptPath = path.join(__dirname, "Source.js");
if (!fs.existsSync(scriptPath)) {
  console.error("FATAL: Source.js not found next to server.mjs");
  process.exit(1);
}

console.log(`[zeus-host] booting workerd runtime (D1: persistent @ ${DATA_DIR}) ...`);

const mf = new Miniflare({
  scriptPath,
  modules: true,
  compatibilityDate: "2025-01-01",
  // Binding expected by ZEUS Panel (auto-creates schema on first request):
  d1Databases: { DB: "zeus-local-d1" },
  // Vars the panel may read before it writes its own config into D1:
  bindings: {
    WORKER_NAME: process.env.WORKER_NAME || "ZEUS_PANEL",
  },
  cache: true,
  // Persist D1 + cache on disk so data survives restarts (Miniflare 4 keys):
  d1Persist: DATA_DIR,
  cachePersist: DATA_DIR,
});

// Miniflare loopback server (random port) — the worker's real HTTP surface:
const upstream = new URL(await mf.ready);
console.log(`[zeus-host] workerd loopback ready on ${upstream.host}`);

function writeTunnelHeaders(req, targetPort, extra) {
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  if (extra) lines.push(extra);
  lines.push(`host: ${req.headers.host || "_"}___PORT_${targetPort}___`);
  return null;
}

const server = http.createServer((req, res) => {
  const headers = { ...req.headers };
  // Pass the real client IP through (the panel limits users per IP):
  if (!headers["cf-connecting-ip"] && req.socket.remoteAddress) {
    headers["cf-connecting-ip"] = req.socket.remoteAddress.replace(/^::ffff:/, "");
  }
  const proxied = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res, { end: true });
    }
  );
  proxied.on("error", (err) => {
    if (!res.headersSent) { res.writeHead(502); res.end("Bad gateway"); }
    else res.destroy();
  });
  req.pipe(proxied, { end: true });
});

// WebSocket upgrade → raw TCP tunnel to the workerd loopback (full duplex):
server.on("upgrade", (req, clientSocket, head) => {
  const upSocket = net.connect(upstream.port, upstream.hostname, () => {
    const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headerLines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    }
    upSocket.write(headerLines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upSocket.write(head);
    clientSocket.pipe(upSocket);
    upSocket.pipe(clientSocket);
  });
  const kill = () => { clientSocket.destroy(); upSocket.destroy(); };
  clientSocket.on("error", kill);
  upSocket.on("error", kill);
  clientSocket.on("close", () => upSocket.destroy());
  upSocket.on("close", () => clientSocket.destroy());
});

server.listen(PORT, HOST, () => {
  console.log(`[zeus-host] ZEUS Panel is live:  http://localhost:${PORT}/panel`);
  console.log("[zeus-host] D1 database persisted at:", DATA_DIR);
});

process.on("SIGTERM", async () => { await mf.dispose(); process.exit(0); });
process.on("SIGINT", async () => { await mf.dispose(); process.exit(0); });
