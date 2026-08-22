import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const GAME_EXECUTABLES = new Set([
  "pathofexile_x64.exe",
  "pathofexile.exe",
  "pathofexilesteam.exe",
  "pathofexile_x64steam.exe",
]);

export function isPoeClientRoot(root: string): boolean {
  if (!root) return false;
  return (
    fs.existsSync(path.join(root, "PathOfExile_x64.exe")) &&
    fs.existsSync(path.join(root, "Bundles2", "_.index.bin"))
  );
}

async function railAppCandidates(base: string): Promise<string[]> {
  if (!fs.existsSync(base)) return [];
  const result: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(base, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(base, entry.name);
    if (isPoeClientRoot(candidate)) result.push(candidate);
  }
  return result;
}

export async function detectPoeClient(lastKnown = ""): Promise<string> {
  const direct = [process.env.POE_CLIENT_DIR || "", lastKnown].filter(Boolean);
  for (const candidate of direct) {
    if (isPoeClientRoot(candidate)) return fs.realpathSync.native(candidate);
  }

  const roots: string[] = [];
  if (process.platform === "win32") {
    for (let code = "C".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      const railApps = path.join(drive, "WeGameApps", "rail_apps");
      if (fs.existsSync(railApps)) roots.push(railApps);
    }
    roots.push(
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Tencent", "WeGameApps", "rail_apps"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Tencent", "WeGameApps", "rail_apps"),
    );
  }
  for (const root of [...new Set(roots)]) {
    const candidates = await railAppCandidates(root);
    if (candidates.length) return fs.realpathSync.native(candidates[0]);
  }
  throw new Error("未自动找到国服客户端，请确认 WeGame 已安装《流放之路》");
}

function csvFirstColumn(line: string): string {
  const match = /^"((?:[^"]|"")*)"/.exec(line.trim());
  return match ? match[1].replace(/""/g, '"') : line.split(",", 1)[0].replace(/^"|"$/g, "");
}

export async function isGameRunning(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/FO", "CSV", "/NH"], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map(csvFirstColumn)
      .some((name) => GAME_EXECUTABLES.has(name.toLocaleLowerCase("en-US")));
  } catch (error) {
    // 无法确认进程状态时按“正在运行”处理，宁可延后也不冒险写客户端。
    console.error("[price-patch] 检查游戏进程失败:", error);
    return true;
  }
}
