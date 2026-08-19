import fs from "fs";
import path from "path";
import util from "util";

const MAX_BYTES = 512 * 1024;
const LEVELS = ["log", "info", "warn", "error"] as const;

let logFile = "";
let inWrite = false;

export function logPath(): string {
  return logFile;
}

function format(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 3 }))).join(" ");
}

function rotate(): void {
  try {
    if (fs.statSync(logFile).size < MAX_BYTES) return;
    fs.rmSync(`${logFile}.1`, { force: true });
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    /* 文件尚不存在或被占用，直接继续追加 */
  }
}

function append(level: string, args: unknown[]): void {
  if (!logFile || inWrite) return;
  inWrite = true;
  try {
    rotate();
    fs.appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${format(args)}\n`, "utf8");
  } catch {
    /* 日志写失败不能影响主流程 */
  } finally {
    inWrite = false;
  }
}

/** Windows GUI 子系统的 exe 没有控制台，console 输出必须落盘才看得到。 */
export function initFileLog(userDataDir: string): void {
  if (logFile) return;
  const dir = path.join(userDataDir, "logs");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  logFile = path.join(dir, "main.log");
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      append(level, args);
    };
  }
  console.log(`==== 启动 pid=${process.pid} ====`);
}
