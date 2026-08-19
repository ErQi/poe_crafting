import fs from "fs";
import path from "path";
import { AppSettings, CraftWorkflow, RuleSet, WorkflowLibrary } from "./models";
import { dataPath, setDataRoot } from "./paths";
import { defaultLibrary } from "./workflow";

export function setProjectRoot(root: string): void {
  setDataRoot(root);
}

/** 配置、模板等可写资源统一走这里：开发时是项目目录，打包后是 userData */
export function resolvePath(relative: string): string {
  return dataPath(relative);
}

const loadErrors: string[] = [];

/** 取走并清空累计的配置读取错误，供界面 initError 展示 */
export function takeLoadErrors(): string[] {
  return loadErrors.splice(0, loadErrors.length);
}

/** 坏文件改名留档，否则每次启动都踩同一颗雷，用户没法自愈 */
export function quarantineFile(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file.replace(/\.json$/i, "")}.corrupt-${stamp}.json`;
  fs.renameSync(file, dest);
  return dest;
}

export function loadJson(file: string, fallback: unknown): unknown {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error("[config] 读取失败:", file, e);
    let note = "";
    try {
      note = `，原文件已备份为 ${path.basename(quarantineFile(file))}`;
    } catch (renameErr) {
      console.error("[config] 备份损坏文件失败:", renameErr);
    }
    loadErrors.push(`${path.basename(file)} 格式有误，已回退到默认配置${note}`);
    return fallback;
  }
}

export function saveJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function loadSettings(file?: string): AppSettings {
  const data = loadJson(file || resolvePath("config/settings.json"), {});
  return AppSettings.fromDict(data && typeof data === "object" ? (data as Record<string, unknown>) : {});
}

export function saveSettings(settings: AppSettings, file?: string): void {
  saveJson(file || resolvePath("config/settings.json"), settings.toDict());
}

export function loadRuleset(file?: string): RuleSet {
  const data = loadJson(file || resolvePath("config/rules.json"), {});
  return RuleSet.fromDict(data && typeof data === "object" ? data : {});
}

export function saveRuleset(ruleset: RuleSet, file?: string): void {
  saveJson(file || resolvePath("config/rules.json"), ruleset.toDict());
}

const OLD_FIXED_RES_NAMES = new Set(["蓝装·生命+火抗", "蓝装·攻击元素+闪抗"]);

function migrateAnyT1Res(library: WorkflowLibrary): void {
  const presets = Object.fromEntries(defaultLibrary().workflows.map((w) => [w.id, w]));
  library.workflows.forEach((item, index) => {
    const fresh = presets[item.id];
    if (fresh && OLD_FIXED_RES_NAMES.has(item.name)) {
      library.workflows[index] = CraftWorkflow.fromDict(fresh.toDict());
    }
  });
}

function libraryFromPayload(data: unknown): WorkflowLibrary | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  if (Array.isArray(raw.workflows)) {
    const library = WorkflowLibrary.fromDict(raw);
    return library.workflows.length ? library : null;
  }
  if (raw.steps) {
    const workflow = CraftWorkflow.fromDict(raw);
    if (!workflow.steps.length) return null;
    if (!raw.id) workflow.id = "imported-legacy";
    if (!workflow.group) workflow.group = "自定义";
    return new WorkflowLibrary({ activeId: workflow.id, workflows: [workflow] });
  }
  return null;
}

/**
 * 单数 workflow.json 是历史包袱：saveLibrary 只写复数形式，它会让用户删掉的流程
 * 每次启动复活。导入后立刻改名，保证只发生一次。
 */
function takeLegacyWorkflow(): CraftWorkflow | null {
  const file = resolvePath("config/workflow.json");
  if (!fs.existsSync(file)) return null;
  const parsed = libraryFromPayload(loadJson(file, {}));
  const workflow = parsed?.workflows.length === 1 ? parsed.workflows[0] : null;
  try {
    fs.renameSync(file, resolvePath("config/workflow.migrated.json"));
  } catch (e) {
    console.error("[config] 归档旧 workflow.json 失败:", e);
  }
  return workflow?.steps.length ? workflow : null;
}

export function loadLibrary(file?: string): WorkflowLibrary {
  const candidates = [...new Set([file || resolvePath("config/workflows.json"), resolvePath("config/workflows.json")])];
  let library: WorkflowLibrary | null = null;
  for (const candidate of candidates) {
    if (library || !fs.existsSync(candidate)) continue;
    library = libraryFromPayload(loadJson(candidate, {}));
  }
  if (!library) library = defaultLibrary();
  else migrateAnyT1Res(library);
  const imported = takeLegacyWorkflow();
  if (imported && !library.workflows.some((w) => w.id === imported.id)) {
    library.workflows.push(imported);
  }
  if (!library.get(library.activeId)) {
    library.activeId = library.workflows[0]?.id ?? "";
  }
  return library;
}

export function saveLibrary(library: WorkflowLibrary, file?: string): void {
  saveJson(file || resolvePath("config/workflows.json"), library.toDict());
}
