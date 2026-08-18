import fs from "fs";
import path from "path";

type ElectronApp = typeof import("electron").app;

/** 非 Electron 环境（如 scripts/ 里的一次性脚本）拿不到 app，全部退化成项目目录。 */
function electronApp(): ElectronApp | null {
  try {
    const { app } = require("electron") as typeof import("electron");
    return app && typeof app.getPath === "function" ? app : null;
  } catch {
    return null;
  }
}

/** 包内只读根：开发时是项目根，打包后是 <resources>/app.asar */
const BUNDLE_ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATES_DIR = "assets/templates";
const CONFIG_FILES = ["settings.json", "rules.json", "workflows.json", "workflow.json"];

let dataRootOverride = "";
let dataRootCache = "";

/** 供 scripts / 测试覆盖可写根目录 */
export function setDataRoot(root: string): void {
  dataRootOverride = root;
  dataRootCache = "";
}

/** 可写根：开发时仍是项目目录，打包后是 userData（exe 所在目录可能只读） */
export function dataRoot(): string {
  if (dataRootOverride) return dataRootOverride;
  if (!dataRootCache) {
    const app = electronApp();
    dataRootCache = app?.isPackaged ? app.getPath("userData") : BUNDLE_ROOT;
  }
  return dataRootCache;
}

/** 用户数据路径（config/*.json、模板等可写文件） */
export function dataPath(relative: string): string {
  return path.isAbsolute(relative) ? relative : path.join(dataRoot(), relative);
}

/**
 * 包内资源路径；asar 内无法直接加载的文件自动指向 app.asar.unpacked。
 * relative 省略时返回包内根目录。
 */
export function bundlePath(relative = "."): string {
  const packed = path.join(BUNDLE_ROOT, relative);
  const unpacked = packed.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return unpacked !== packed && fs.existsSync(unpacked) ? unpacked : packed;
}

function copyIfMissing(relative: string): boolean {
  const src = bundlePath(relative);
  const dest = dataPath(relative);
  if (fs.existsSync(dest) || !fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function bundledTemplates(): string[] {
  try {
    return fs.readdirSync(bundlePath(TEMPLATES_DIR)).map((name) => `${TEMPLATES_DIR}/${name}`);
  } catch {
    return [];
  }
}

/** 打包后首次运行：把包内默认配置与模板补齐到可写目录；开发模式原地读写，不动。 */
export function seedUserData(): string[] {
  if (dataRoot() === BUNDLE_ROOT) return [];
  const targets = [...CONFIG_FILES.map((name) => `config/${name}`), ...bundledTemplates()];
  let copied = 0;
  for (const relative of targets) {
    try {
      if (copyIfMissing(relative)) copied += 1;
    } catch (e) {
      console.error("[paths] 初始化默认资源失败:", relative, e);
    }
  }
  const logs = [`用户数据目录: ${dataRoot()}`];
  if (copied) logs.push(`已从安装包补齐 ${copied} 个默认配置/模板文件`);
  return logs;
}
