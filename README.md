# ZEUS Panel on Node.js host

Runs the unmodified ZEUS Panel (panel-zeus/Z-E-U-S v2.4.2) Cloudflare Worker on any Node.js host via Miniflare (workerd) with persistent local D1.

## Deploy
1. Push this repo to GitHub
2. Deploy as **Node.js** service (install: `npm install`, start: `npm start`)
3. Open `https://<your-domain>/panel` and set the panel password

## Files
- `Source.js` — untouched ZEUS source (do not edit)
- `server.mjs` — runtime adapter (workerd + D1 + HTTP/WS proxy)
- `package.json` — deps (miniflare)
