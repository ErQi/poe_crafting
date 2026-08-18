import fs from "fs";
import path from "path";
import { AppSettings, CraftWorkflow, RuleSet, WorkflowLibrary } from "./models";
import { defaultLibrary } from "./workflow";

let projectRootPath = "";

export function setProjectRoot(root: string): void {
  projectRootPath = root;
}

export function projectRoot(): string {
  return projectRootPath || path.resolve(__dirname, "..", "..");
}

export function resolvePath(relative: string): string {
  return path.isAbsolute(relative) ? relative : path.join(projectRoot(), relative);
}

export function loadJson(file: string, fallback: unknown): unknown {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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

export function loadLibrary(file?: string): WorkflowLibrary {
  const primary = file || resolvePath("config/workflows.json");
  const candidates = [primary, resolvePath("config/workflows.json"), resolvePath("config/workflow.json")];
  const unique = [...new Set(candidates)];
  let library: WorkflowLibrary | null = null;
  let imported: CraftWorkflow | undefined;
  for (const candidate of unique) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = libraryFromPayload(loadJson(candidate, {}));
    if (!parsed) continue;
    if (path.basename(candidate) === "workflow.json" && parsed.workflows.length === 1) {
      imported = parsed.workflows[0];
      continue;
    }
    if (!library) library = parsed;
  }
  if (!library) library = defaultLibrary();
  else migrateAnyT1Res(library);
  if (imported?.steps.length && !library.workflows.some((w) => w.id === imported!.id)) {
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
