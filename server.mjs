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
const os = await import("node:os");
// Pick the first WRITABLE data dir: ZEUS_DATA env, ./<script-dir>/.zeus-data, /data, /tmp fallback.
// Some PaaS runners execute as a non-root user with a read-only app dir, so we
// must not crash on mkdir — try candidates in order and keep D1 persistent.
function pickDataDir() {
  const candidates = [];
  if (process.env.ZEUS_DATA) candidates.push(path.resolve(process.env.ZEUS_DATA));
  candidates.push(path.join(__dirname, ".zeus-data"));
  candidates.push("/data/.zeus-data");
  candidates.push(path.join(os.tmpdir(), "zeus-data"));
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (e) {
      console.log(`[zeus-host] data dir unusable (${dir}): ${e.code || e.message}`);
    }
  }
  console.error("FATAL: no writable data dir found for D1 persistence");
  process.exit(1);
}
const DATA_DIR = pickDataDir();

const scriptPath = path.join(__dirname, "Source.js");
if (!fs.existsSync(scriptPath)) {
  console.error("FATAL: Source.js not found next to server.mjs");
  process.exit(1);
}

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Alpine (musl) containers cannot exec the glibc-linked workerd binary
// directly — it needs /lib64/ld-linux-x86-64.so.2 which musl systems lack.
// We ship a small glibc 2.35 runtime in ./zeus-libs and launch workerd
// through its loader. Miniflare honours MINIFLARE_WORKERD_PATH for exactly
// this purpose, so no file inside node_modules is ever modified.
function prepareMuslWorkerd() {
  const isMusl = fs.existsSync("/etc/alpine-release") || process.env.ZEUS_FORCE_MUSL === "1";
  if (!isMusl) return;
  let workerdBin;
  try {
    workerdBin = require.resolve("@cloudflare/workerd-linux-64/bin/workerd");
  } catch (e) {
    console.error("[zeus-host] cannot resolve workerd binary:", e.message);
    return;
  }
  const libsDir = path.join(__dirname, "zeus-libs");
  const loader = path.join(libsDir, "ld-linux-x86-64.so.2");
  if (!fs.existsSync(loader)) {
    console.error("[zeus-host] zeus-libs loader missing; continuing without musl shim");
    return;
  }
  const launcher = path.join(DATA_DIR, "zeus-workerd-launcher.sh");
  const script = [
    "#!/bin/sh",
    `exec "${loader}" --library-path "${libsDir}" "${workerdBin}" "$@"`,
    "",
  ].join("\n");
  fs.writeFileSync(launcher, script);
  fs.chmodSync(launcher, 0o755);
  process.env.MINIFLARE_WORKERD_PATH = launcher;
  console.log("[zeus-host] musl detected — workerd will run via shipped glibc loader");
}
prepareMuslWorkerd();

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
