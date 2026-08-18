const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "electron", "dist");
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(
  path.join(root, "electron", "overlay.html"),
  path.join(outDir, "overlay.html"),
);

esbuild.buildSync({
  entryPoints: [
    path.join(root, "electron", "main.ts"),
    path.join(root, "electron", "preload.ts"),
    path.join(root, "electron", "overlay.ts"),
  ],
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["electron", "koffi", "opencv-wasm"],
});
