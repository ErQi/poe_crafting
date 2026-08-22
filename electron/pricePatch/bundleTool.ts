import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { bundlePath } from "../engine/paths";

const execFileAsync = promisify(execFile);
const TOOL_TIMEOUT_MS = 3 * 60 * 1000;

interface ToolResult {
  ok: boolean;
  customBundles?: string[];
  bytes?: number;
  resourceBundles?: string[];
}

function toolExecutable(): string {
  return process.env.POE_BUNDLE_TOOL || bundlePath("assets/patcher/win-x64/PoeBundleTool.exe");
}

function cleanBundlePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").replace(/\\/g, "/"))
    .filter(
      (item) =>
        item.toLowerCase().endsWith(".bundle.bin") &&
        !item.startsWith("/") &&
        !/^[A-Za-z]:/.test(item) &&
        !item.split("/").includes(".."),
    );
}

function cleanCustomBundles(value: unknown): string[] {
  return cleanBundlePaths(value).filter((item) => /^LibGGPK3\/[A-Za-z0-9._-]+\.bundle\.bin$/i.test(item));
}

export class PoeBundleTool {
  constructor(private readonly executable = toolExecutable()) {}

  private async run(args: string[]): Promise<ToolResult> {
    if (!fs.existsSync(this.executable)) {
      throw new Error("客户端补丁组件缺失，请重新构建或安装 POE Tools");
    }
    try {
      const { stdout, stderr } = await execFileAsync(this.executable, args, {
        windowsHide: true,
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      });
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
      const parsed = JSON.parse(line) as ToolResult;
      if (!parsed.ok) throw new Error(stderr.trim() || "Bundle 工具未完成操作");
      parsed.customBundles = cleanCustomBundles(parsed.customBundles);
      return parsed;
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new Error(`客户端资源处理失败: ${detail.stderr?.trim() || detail.message || String(error)}`);
    }
  }

  async listCustomBundles(indexFile: string): Promise<string[]> {
    const result = await this.run(["list-custom", indexFile]);
    return result.customBundles || [];
  }

  async resourceBundles(indexFile: string, resources: string[]): Promise<string[]> {
    const result = await this.run(["resource-bundles", indexFile, ...resources]);
    return cleanBundlePaths(result.resourceBundles);
  }

  async extract(
    indexFile: string,
    readRoot: string,
    overlayRoot: string,
    resourcePath: string,
    outputFile: string,
  ): Promise<string[]> {
    await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
    const result = await this.run(["extract", indexFile, readRoot, overlayRoot, resourcePath, outputFile]);
    return result.customBundles || [];
  }

  async replace(
    indexFile: string,
    readRoot: string,
    overlayRoot: string,
    resourcePath: string,
    inputFile: string,
  ): Promise<string[]> {
    const result = await this.run(["replace", indexFile, readRoot, overlayRoot, resourcePath, inputFile]);
    return result.customBundles || [];
  }

  async probeExclusive(files: string[]): Promise<void> {
    if (!files.length) return;
    await this.run(["probe", ...files]);
  }
}
