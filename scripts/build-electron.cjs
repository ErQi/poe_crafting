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

// sourcemap 只在 dev 下产出：420KB 的 .map 会进 asar 并把源码完整暴露出去
const sourcemap = process.argv.includes("--sourcemap");
if (!sourcemap) {
  for (const name of fs.readdirSync(outDir)) {
    if (name.endsWith(".map")) fs.rmSync(path.join(outDir, name), { force: true });
  }
}

esbuild.buildSync({
  entryPoints: [
    path.join(root, "electron", "main.ts"),
    path.join(root, "electron", "preload.ts"),
    path.join(root, "electron", "overlay.ts"),
    path.join(root, "electron", "overlayPreload.ts"),
  ],
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap,
  external: ["electron", "koffi", "opencv-wasm"],
});
