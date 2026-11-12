// Bundles the app: node build.mjs → dist/{index.html, assets/*, vercel.json, _headers}. Adapted from Encrypted
// Account's web/build.mjs: hashed asset names, COOP/COEP headers (multi-threaded TFHE), and the SDK's unused WASM
// versions and its user-decryption library stubbed out (the app encrypts and asks for public decryptions only).
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");

const stubUnused = {
  name: "stub-unused-wasm",
  setup(b) {
    b.onResolve({ filter: /^\.\/v(1\.5\.3|0\.13\.10|0\.13\.20-0)\// }, (args) => {
      const fromLoader = /loadTfheLib\.js$|loadKmsLib\.js$/.test(args.importer);
      return fromLoader ? { path: args.path, namespace: "stub" } : undefined;
    });
    b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: `throw new Error("not bundled in the app: ${args.path}");`,
      loader: "js",
    }));
  },
};

const ISOLATION = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];

export async function build({ minify = true } = {}) {
  fs.mkdirSync(DIST, { recursive: true });
  for (const name of fs.readdirSync(DIST)) {
    if (name !== ".vercel") fs.rmSync(path.join(DIST, name), { recursive: true, force: true });
  }
  const result = await esbuild.build({
    plugins: [stubUnused],
    entryPoints: { app: path.join(HERE, "src", "app.tsx"), "app-style": path.join(HERE, "src", "styles", "app.css") },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022", "safari16"],
    jsx: "automatic",
    jsxImportSource: "preact",
    entryNames: "[name]-[hash]",
    outdir: path.join(DIST, "assets"),
    metafile: true,
    minify,
    sourcemap: !minify,
    legalComments: "none",
    external: ["node:url"],
    logLevel: "warning",
  });
  const out = {};
  for (const [file, meta] of Object.entries(result.metafile.outputs)) {
    if (!meta.entryPoint) continue;
    const base = path.basename(file);
    out[base.replace(/-[A-Z0-9]{8}\.(js|css)$/, "") + path.extname(base)] = `/assets/${base}`;
  }
  const refs = { "/assets/app.js": out["app.js"], "/assets/app.css": out["app-style.css"] };
  let html = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
  for (const [from, to] of Object.entries(refs)) {
    if (!to) throw new Error(`build: no output for ${from}`);
    html = html.split(`"${from}"`).join(`"${to}"`);
  }
  fs.writeFileSync(path.join(DIST, "index.html"), html);
  const vercel = {
    cleanUrls: true,
    headers: [
      { source: "/(.*)", headers: ISOLATION },
      { source: "/assets/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ],
  };
  fs.writeFileSync(path.join(DIST, "vercel.json"), JSON.stringify(vercel, null, 2) + "\n");
  fs.writeFileSync(path.join(DIST, "_headers"), "/*\n" + ISOLATION.map((h) => `  ${h.key}: ${h.value}`).join("\n") + "\n");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const minify = !process.argv.includes("--dev");
  await build({ minify });
  const size = (f) => (fs.statSync(path.join(DIST, f)).size / 1024).toFixed(0) + " KB";
  for (const f of fs.readdirSync(path.join(DIST, "assets"))) console.log(`dist/assets/${f}  ${size("assets/" + f)}`);
}
