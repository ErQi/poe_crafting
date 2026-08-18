const path = require("path");
const esbuild = require("esbuild");
const root = path.join(__dirname, "..");
const src = `
import { setProjectRoot, resolvePath } from "./electron/engine/configStore.ts";
import { CURRENCIES } from "./electron/engine/currencies.ts";
import { ensureCurrencyIcons } from "./electron/engine/currencyIcons.ts";
setProjectRoot(${JSON.stringify(root)});
const dir = resolvePath("assets/templates");
console.log("基础通货 " + CURRENCIES.length + " 个，目录 " + dir);
ensureCurrencyIcons(dir, (m) => console.log(m), 180000).then((r) => {
  console.log("已下载: " + (r.downloaded.join("、") || "无"));
  console.log("已存在跳过: " + (r.skipped.join("、") || "无"));
  if (r.failed.length) {
    console.error("下载失败:");
    for (const f of r.failed) console.error("  " + f.label + " " + f.file + " — " + f.reason);
    process.exit(1);
  }
  console.log("done");
}).catch((e) => { console.error(e); process.exit(1); });
`;
const out = esbuild.buildSync({
  stdin: { contents: src, resolveDir: root, sourcefile: "fetch.ts", loader: "ts" },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
});
eval(out.outputFiles[0].text);
