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
/** 出厂默认配置与用户运行时配置分开存放，避免打包机的临时状态变成新用户的默认值 */
const DEFAULTS_DIR = "config/defaults";
const CONFIG_DIR = "config";
const SEED_MARKER = "config/.seed-version";
const SEED_VERSION = 1;
/** 老用户（一直用 npm run dev / npm start）留在项目目录里的配置 */
const LEGACY_IMPORT_FILES = ["workflows.json", "rules.json", "settings.json", "workflow.json"];

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

function copyIfMissing(srcRelative: string, destRelative: string): boolean {
  const src = bundlePath(srcRelative);
  const dest = dataPath(destRelative);
  if (fs.existsSync(dest) || !fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function listBundled(dir: string, ext = ""): string[] {
  try {
    return fs.readdirSync(bundlePath(dir)).filter((name) => !ext || name.endsWith(ext));
  } catch {
    return [];
  }
}

/** 出厂默认 config/defaults/x.json → 运行时 config/x.json；模板保持同名 */
function seedTargets(): [string, string][] {
  return [
    ...listBundled(DEFAULTS_DIR, ".json").map(
      (name): [string, string] => [`${DEFAULTS_DIR}/${name}`, `${CONFIG_DIR}/${name}`],
    ),
    ...listBundled(TEMPLATES_DIR).map(
      (name): [string, string] => [`${TEMPLATES_DIR}/${name}`, `${TEMPLATES_DIR}/${name}`],
    ),
  ];
}

function readSeedVersion(): number {
  try {
    return Number(fs.readFileSync(dataPath(SEED_MARKER), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

/** 打包后首次运行：把包内默认配置与模板补齐到可写目录；开发模式原地读写，不动。 */
export function seedUserData(): string[] {
  if (dataRoot() === BUNDLE_ROOT) return [];
  let copied = 0;
  for (const [src, dest] of seedTargets()) {
    try {
      if (copyIfMissing(src, dest)) copied += 1;
    } catch (e) {
      console.error("[paths] 初始化默认资源失败:", dest, e);
    }
  }
  const logs = [`用户数据目录: ${dataRoot()}`];
  if (copied) logs.push(`已从安装包补齐 ${copied} 个默认配置/模板文件`);
  const previous = readSeedVersion();
  if (previous !== SEED_VERSION) {
    try {
      fs.mkdirSync(dataPath(CONFIG_DIR), { recursive: true });
      fs.writeFileSync(dataPath(SEED_MARKER), `${SEED_VERSION}\n`, "utf8");
    } catch (e) {
      console.error("[paths] 写 seed 标记失败:", e);
    }
  }
  return logs;
}

/** 可写目录里是否已经有用户配置（决定要不要提示导入旧数据） */
export function hasUserConfig(): boolean {
  return LEGACY_IMPORT_FILES.some((name) => fs.existsSync(dataPath(`${CONFIG_DIR}/${name}`)));
}

/**
 * portable exe 同目录下的旧配置目录。老用户一直用项目目录跑，装了 portable 后
 * 会以为流程库丢了，这里给出可导入的来源；没有可导入内容时返回空串。
 */
export function legacyConfigDir(): string {
  const base = process.env.PORTABLE_EXECUTABLE_DIR || "";
  if (!base) return "";
  const dir = path.join(base, CONFIG_DIR);
  if (path.resolve(dir) === path.resolve(dataPath(CONFIG_DIR))) return "";
  return LEGACY_IMPORT_FILES.some((name) => fs.existsSync(path.join(dir, name))) ? dir : "";
}

/** 把旧目录里的配置复制过来（只补不覆盖），返回实际导入的文件名 */
export function importLegacyConfig(dir: string): string[] {
  const done: string[] = [];
  for (const name of LEGACY_IMPORT_FILES) {
    const src = path.join(dir, name);
    const dest = dataPath(`${CONFIG_DIR}/${name}`);
    try {
      if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      done.push(name);
    } catch (e) {
      console.error("[paths] 导入旧配置失败:", name, e);
    }
  }
  return done;
}
