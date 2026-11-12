// Serves dist/ locally with the COOP/COEP headers the app is built for.   node serve.mjs [port]
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const port = Number(process.argv[2] ?? 8791);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png" };

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`ZEC Desk app on http://localhost:${port}`));
