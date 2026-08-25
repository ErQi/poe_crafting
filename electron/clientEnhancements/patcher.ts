import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { resolvePath } from "../engine/configStore";
import { PoeBundleTool } from "../pricePatch/bundleTool";
import { detectPoeClient, isGameRunning, isPoeClientRoot, normalizePoeClientRoot } from "../pricePatch/clientLocator";
import { GameRunningError } from "../pricePatch/clientPatcher";
import {
  assertFilesStable,
  recoverInterruptedTransactions,
  replaceFilesTransaction,
  resolveInside,
  sha256File,
  type ReplacementFile,
} from "../pricePatch/fileSafety";
import {
  cleanCameraResource,
  cleanEnvironmentFogResource,
  cleanMinimapBlendingResource,
  cleanMinimapVisibilityResource,
  patchCameraResource,
  patchEnvironmentFogResource,
  patchMinimapBlendingResource,
  patchMinimapVisibilityResource,
} from "./transform";
import type { ClientEnhancementConfig, ClientEnhancementState } from "./types";

const INDEX_RELATIVE = "Bundles2/_.index.bin";
export const CAMERA_RESOURCE = "metadata/characters/character.ot";
export const MINIMAP_VISIBILITY_RESOURCE = "shaders/minimap_visibility_pixel.hlsl";
export const MINIMAP_BLENDING_RESOURCE = "shaders/minimap_blending_pixel.hlsl";
export const ENVIRONMENT_FOG_RESOURCE = "shaders/renderer/fog.ffx";
const LEGACY_ENHANCEMENT_RESOURCES = [
  CAMERA_RESOURCE,
  MINIMAP_VISIBILITY_RESOURCE,
  MINIMAP_BLENDING_RESOURCE,
] as const;
export const ENHANCEMENT_RESOURCES = [...LEGACY_ENHANCEMENT_RESOURCES, ENVIRONMENT_FOG_RESOURCE] as const;

interface BaselineResource {
  resourcePath: string;
  originalBackupPath: string;
  originalSize: number;
  originalSha256: string;
  cleanBackupPath: string;
  cleanSize: number;
  cleanSha256: string;
}

interface BaselineManifest {
  schemaVersion: 1 | 2;
  id: string;
  createdAt: string;
  clientRoot: string;
  executableSha256: string;
  resources: BaselineResource[];
}

interface CurrentResources {
  executableSha256: string;
  buffers: Record<string, Buffer>;
  hashes: Record<string, string>;
  customBundles: string[];
  resourceBundles: string[];
}

interface PreparedBaseline {
  manifest: BaselineManifest;
  dir: string;
  current: CurrentResources;
}

interface OperationMarker {
  schemaVersion: 1;
  kind: "apply" | "restore";
  clientRoot: string;
  baselineId: string;
  executableSha256: string;
  resourceSha256: Record<string, string>;
  createdAt: string;
}

export interface EnhancementPatchResult {
  baselineId: string;
  executableSha256: string;
  resourceSha256: Record<string, string>;
  changed: boolean;
}

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLocaleLowerCase("en-US") === path.resolve(b).toLocaleLowerCase("en-US");
}

function safeBaselineId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.promises.rename(temporary, file);
}

function livePath(clientRoot: string, relativePath: string): string {
  return resolveInside(path.resolve(clientRoot), relativePath);
}

function bundleRoot(clientRoot: string): string {
  return path.join(clientRoot, "Bundles2");
}

function resourceFileName(resourcePath: string): string {
  return resourcePath.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function allHashesMatch(
  actual: Record<string, string>,
  expected: Record<string, string>,
  resources: readonly string[] = ENHANCEMENT_RESOURCES,
): boolean {
  return resources.every((resource) => Boolean(expected[resource]) && actual[resource] === expected[resource]);
}

export class ClientEnhancementPatcher {
  private readonly patchRoot: string;
  private readonly operationMarker: string;

  constructor(
    private readonly tool = new PoeBundleTool(),
    private readonly locateClient: (lastKnown?: string) => Promise<string> = detectPoeClient,
    private readonly gameRunning: () => Promise<boolean> = isGameRunning,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.patchRoot = resolvePath("client-enhancements");
    this.operationMarker = path.join(this.patchRoot, "last-operation.json");
  }

  async clientRoot(lastKnown = ""): Promise<string> {
    const root = lastKnown ? normalizePoeClientRoot(lastKnown) : await this.locateClient();
    if (!isPoeClientRoot(root)) throw new Error("国服客户端目录不完整");
    return path.resolve(root);
  }

  private tempDir(label: string): string {
    return path.join(this.patchRoot, "tmp", `${label}-${randomUUID()}`);
  }

  private baselineDir(id: string): string {
    if (!safeBaselineId(id)) throw new Error("增强补丁基线标识不合法");
    return path.join(this.patchRoot, "baselines", id);
  }

  private async readOperationMarker(clientRoot: string): Promise<OperationMarker | null> {
    try {
      const marker = JSON.parse(await fs.promises.readFile(this.operationMarker, "utf8")) as OperationMarker;
      if (
        marker.schemaVersion !== 1 ||
        (marker.kind !== "apply" && marker.kind !== "restore") ||
        !safeBaselineId(marker.baselineId) ||
        !samePath(marker.clientRoot, clientRoot)
      ) return null;
      return marker;
    } catch {
      return null;
    }
  }

  private async writeOperationMarker(
    kind: OperationMarker["kind"],
    clientRoot: string,
    baselineId: string,
    executableSha256: string,
    resourceSha256: Record<string, string>,
  ): Promise<void> {
    await writeJson(this.operationMarker, {
      schemaVersion: 1,
      kind,
      clientRoot,
      baselineId,
      executableSha256,
      resourceSha256,
      createdAt: new Date().toISOString(),
    } satisfies OperationMarker);
  }

  private async assertClientSafe(clientRoot: string): Promise<void> {
    if (await this.gameRunning()) throw new GameRunningError();
    await recoverInterruptedTransactions(clientRoot);
    const index = livePath(clientRoot, INDEX_RELATIVE);
    const [customBundles, resourceBundles] = await Promise.all([
      this.tool.listCustomBundles(index),
      this.tool.resourceBundles(index, [...ENHANCEMENT_RESOURCES]),
    ]);
    const related = [...new Set([...customBundles, ...resourceBundles])]
      .map((item) => livePath(clientRoot, `Bundles2/${slash(item)}`))
      .filter(fs.existsSync);
    await assertFilesStable([index, ...related], 1500);
    await this.tool.probeExclusive([index, ...related]);
    const probe = path.join(bundleRoot(clientRoot), `.poecrafting-enhancement-probe-${randomUUID()}`);
    const handle = await fs.promises.open(probe, "wx");
    await handle.close();
    await fs.promises.unlink(probe);
    if (await this.gameRunning()) throw new GameRunningError();
  }

  private async currentResources(clientRoot: string): Promise<CurrentResources> {
    const temporary = this.tempDir("inspect");
    const index = livePath(clientRoot, INDEX_RELATIVE);
    const bundles = bundleRoot(clientRoot);
    const buffers: Record<string, Buffer> = {};
    let customBundles: string[] = [];
    try {
      for (const resource of ENHANCEMENT_RESOURCES) {
        const output = path.join(temporary, resourceFileName(resource));
        const custom = await this.tool.extract(index, bundles, bundles, resource, output);
        if (!customBundles.length) customBundles = custom;
        buffers[resource] = await fs.promises.readFile(output);
      }
      const resourceBundles = await this.tool.resourceBundles(index, [...ENHANCEMENT_RESOURCES]);
      return {
        executableSha256: await sha256File(path.join(clientRoot, "PathOfExile_x64.exe")),
        buffers,
        hashes: Object.fromEntries(ENHANCEMENT_RESOURCES.map((resource) => [resource, hashBuffer(buffers[resource])])),
        customBundles,
        resourceBundles,
      };
    } finally {
      await fs.promises.rm(temporary, { recursive: true, force: true });
    }
  }

  private cleanResources(current: CurrentResources): Record<string, Buffer> {
    return {
      [CAMERA_RESOURCE]: cleanCameraResource(current.buffers[CAMERA_RESOURCE]),
      [MINIMAP_VISIBILITY_RESOURCE]: cleanMinimapVisibilityResource(current.buffers[MINIMAP_VISIBILITY_RESOURCE]),
      [MINIMAP_BLENDING_RESOURCE]: cleanMinimapBlendingResource(current.buffers[MINIMAP_BLENDING_RESOURCE]),
      [ENVIRONMENT_FOG_RESOURCE]: cleanEnvironmentFogResource(current.buffers[ENVIRONMENT_FOG_RESOURCE]),
    };
  }

  private async writeBaselineResource(
    root: string,
    relativePath: string,
    content: Buffer,
  ): Promise<{ path: string; size: number; sha256: string }> {
    const target = resolveInside(root, relativePath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content, { flag: "wx" });
    return { path: slash(relativePath), size: content.length, sha256: hashBuffer(content) };
  }

  private async createBaselineFromBuffers(
    clientRoot: string,
    current: CurrentResources,
    original: Record<string, Buffer>,
    clean: Record<string, Buffer>,
  ): Promise<PreparedBaseline> {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const id = `${stamp}-${current.executableSha256.slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const finalDir = this.baselineDir(id);
    const temporary = path.join(this.patchRoot, "baselines", `.building-${id}`);
    await fs.promises.mkdir(temporary, { recursive: true });
    try {
      const resources: BaselineResource[] = [];
      for (const resourcePath of ENHANCEMENT_RESOURCES) {
        if (!original[resourcePath] || !clean[resourcePath]) {
          throw new Error(`客户端增强基线缺少待备份资源: ${resourcePath}`);
        }
        const name = resourceFileName(resourcePath);
        const originalFile = await this.writeBaselineResource(temporary, `original/${name}`, original[resourcePath]);
        const normalized = await this.writeBaselineResource(temporary, `clean/${name}`, clean[resourcePath]);
        resources.push({
          resourcePath,
          originalBackupPath: originalFile.path,
          originalSize: originalFile.size,
          originalSha256: originalFile.sha256,
          cleanBackupPath: normalized.path,
          cleanSize: normalized.size,
          cleanSha256: normalized.sha256,
        });
      }
      const manifest: BaselineManifest = {
        schemaVersion: 2,
        id,
        createdAt: new Date().toISOString(),
        clientRoot,
        executableSha256: current.executableSha256,
        resources,
      };
      await writeJson(path.join(temporary, "manifest.json"), manifest);
      await fs.promises.mkdir(path.dirname(finalDir), { recursive: true });
      await fs.promises.rename(temporary, finalDir);
      this.log(`已建立客户端增强资源基线: ${id}`);
      return { manifest, dir: finalDir, current };
    } catch (error) {
      await fs.promises.rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  private async createBaseline(clientRoot: string, current: CurrentResources): Promise<PreparedBaseline> {
    return this.createBaselineFromBuffers(clientRoot, current, current.buffers, this.cleanResources(current));
  }

  private async loadBaseline(id: string, clientRoot: string): Promise<{ manifest: BaselineManifest; dir: string }> {
    const dir = this.baselineDir(id);
    const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, "manifest.json"), "utf8")) as BaselineManifest;
    if ((manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) || manifest.id !== id || !samePath(manifest.clientRoot, clientRoot)) {
      throw new Error("客户端增强基线不属于当前客户端或版本不受支持");
    }
    const expectedResources = manifest.schemaVersion === 1 ? LEGACY_ENHANCEMENT_RESOURCES : ENHANCEMENT_RESOURCES;
    const resourcePaths = manifest.resources.map((item) => item.resourcePath);
    if (
      resourcePaths.length !== expectedResources.length ||
      new Set(resourcePaths).size !== resourcePaths.length ||
      !expectedResources.every((resource) => resourcePaths.includes(resource))
    ) {
      throw new Error("客户端增强基线资源不完整");
    }
    for (const resource of manifest.resources) {
      for (const [backupPath, size, sha256] of [
        [resource.originalBackupPath, resource.originalSize, resource.originalSha256],
        [resource.cleanBackupPath, resource.cleanSize, resource.cleanSha256],
      ] as const) {
        const file = resolveInside(dir, backupPath);
        const stat = await fs.promises.stat(file);
        if (!stat.isFile() || stat.size !== size || (await sha256File(file)) !== sha256) {
          throw new Error(`客户端增强基线校验失败: ${backupPath}`);
        }
      }
    }
    return { manifest, dir };
  }

  private async migrateLegacyBaseline(
    clientRoot: string,
    current: CurrentResources,
    loaded: { manifest: BaselineManifest; dir: string },
  ): Promise<PreparedBaseline> {
    const prepared = { ...loaded, current };
    const original = await this.baselineBuffers(prepared, "original");
    const clean = await this.baselineBuffers(prepared, "clean");
    original[ENVIRONMENT_FOG_RESOURCE] = current.buffers[ENVIRONMENT_FOG_RESOURCE];
    clean[ENVIRONMENT_FOG_RESOURCE] = cleanEnvironmentFogResource(current.buffers[ENVIRONMENT_FOG_RESOURCE]);
    this.log("正在把旧版客户端增强备份扩展为环境去雾兼容基线");
    return this.createBaselineFromBuffers(clientRoot, current, original, clean);
  }

  private async prepareBaseline(clientRoot: string, state: ClientEnhancementState): Promise<PreparedBaseline> {
    await this.assertClientSafe(clientRoot);
    const current = await this.currentResources(clientRoot);
    if (!state.baselineId) return this.createBaseline(clientRoot, current);

    let loaded: { manifest: BaselineManifest; dir: string };
    try {
      loaded = await this.loadBaseline(state.baselineId, clientRoot);
    } catch (error) {
      if (state.applied) throw new Error(`找不到可验证的增强补丁备份，已停止写入：${String(error)}`);
      return this.createBaseline(clientRoot, current);
    }
    if (loaded.manifest.executableSha256 !== current.executableSha256) {
      this.log("检测到客户端版本变化，正在为增强功能建立新基线");
      return this.createBaseline(clientRoot, current);
    }

    const marker = await this.readOperationMarker(clientRoot);
    const baselineResources = loaded.manifest.resources.map((item) => item.resourcePath);
    if (state.applied) {
      const stateMatches = allHashesMatch(current.hashes, state.appliedResourceSha256, baselineResources);
      const completedOperation =
        marker?.baselineId === loaded.manifest.id &&
        marker.executableSha256 === current.executableSha256 &&
        allHashesMatch(current.hashes, marker.resourceSha256, baselineResources);
      if (!stateMatches && !completedOperation) {
        throw new Error("增强功能应用后目标资源被其他程序修改；为避免覆盖，已停止操作");
      }
    } else {
      const original = Object.fromEntries(loaded.manifest.resources.map((item) => [item.resourcePath, item.originalSha256]));
      if (!allHashesMatch(current.hashes, original, baselineResources)) {
        // 未应用时外部工具改过同一批资源，把最新状态留作新的可恢复基线。
        return this.createBaseline(clientRoot, current);
      }
    }
    if (loaded.manifest.schemaVersion === 1) {
      return this.migrateLegacyBaseline(clientRoot, current, loaded);
    }
    return { ...loaded, current };
  }

  private async baselineBuffers(
    prepared: PreparedBaseline,
    kind: "original" | "clean",
  ): Promise<Record<string, Buffer>> {
    const result: Record<string, Buffer> = {};
    for (const resource of prepared.manifest.resources) {
      const relative = kind === "original" ? resource.originalBackupPath : resource.cleanBackupPath;
      result[resource.resourcePath] = await fs.promises.readFile(resolveInside(prepared.dir, relative));
    }
    return result;
  }

  private desiredResources(clean: Record<string, Buffer>, config: ClientEnhancementConfig): Record<string, Buffer> {
    return {
      [CAMERA_RESOURCE]: patchCameraResource(
        clean[CAMERA_RESOURCE],
        config.viewDistanceEnabled,
        config.viewDistanceMultiplier,
      ),
      [MINIMAP_VISIBILITY_RESOURCE]: patchMinimapVisibilityResource(
        clean[MINIMAP_VISIBILITY_RESOURCE],
        config.minimapEnabled,
      ),
      [MINIMAP_BLENDING_RESOURCE]: patchMinimapBlendingResource(
        clean[MINIMAP_BLENDING_RESOURCE],
        config.minimapEnabled,
        config.minimapColor,
      ),
      [ENVIRONMENT_FOG_RESOURCE]: patchEnvironmentFogResource(
        clean[ENVIRONMENT_FOG_RESOURCE],
        config.environmentDefogEnabled,
      ),
    };
  }

  private async copyStageFiles(clientRoot: string, stageRoot: string, current: CurrentResources): Promise<string[]> {
    const bundleRelatives = [...new Set([...current.customBundles, ...current.resourceBundles])]
      .map((item) => `Bundles2/${slash(item)}`);
    const relatives = [INDEX_RELATIVE, ...bundleRelatives];
    for (const relative of relatives) {
      const destination = livePath(stageRoot, relative);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.copyFile(livePath(clientRoot, relative), destination, fs.constants.COPYFILE_EXCL);
    }
    return relatives;
  }

  private async changedReplacement(
    clientRoot: string,
    stageRoot: string,
    relativePath: string,
  ): Promise<ReplacementFile | null> {
    const staged = livePath(stageRoot, relativePath);
    if (!(await exists(staged))) return null;
    const live = livePath(clientRoot, relativePath);
    if ((await exists(live)) && (await sha256File(live)) === (await sha256File(staged))) return null;
    return { relativePath, sourcePath: staged };
  }

  private async commitSafe(clientRoot: string, replacements: ReplacementFile[], executableSha256: string): Promise<void> {
    if (await this.gameRunning()) throw new GameRunningError();
    const existing = replacements.map((item) => livePath(clientRoot, item.relativePath)).filter(fs.existsSync);
    if (existing.length) {
      await assertFilesStable(existing, 1500);
      await this.tool.probeExclusive(existing);
    }
    if ((await sha256File(path.join(clientRoot, "PathOfExile_x64.exe"))) !== executableSha256) {
      throw new Error("客户端在增强补丁准备期间发生更新，已取消写入");
    }
    if (await this.gameRunning()) throw new GameRunningError();
  }

  private async writeResources(
    clientRoot: string,
    prepared: PreparedBaseline,
    desired: Record<string, Buffer>,
    kind: OperationMarker["kind"],
  ): Promise<EnhancementPatchResult> {
    const resourceSha256 = Object.fromEntries(
      ENHANCEMENT_RESOURCES.map((resource) => [resource, hashBuffer(desired[resource])]),
    );
    if (allHashesMatch(prepared.current.hashes, resourceSha256)) {
      return {
        baselineId: prepared.manifest.id,
        executableSha256: prepared.current.executableSha256,
        resourceSha256,
        changed: false,
      };
    }

    const stageRoot = this.tempDir(kind);
    try {
      const stagedRelatives = await this.copyStageFiles(clientRoot, stageRoot, prepared.current);
      const stageIndex = livePath(stageRoot, INDEX_RELATIVE);
      const stageBundles = bundleRoot(stageRoot);
      for (const resource of ENHANCEMENT_RESOURCES) {
        const input = path.join(stageRoot, "inputs", resourceFileName(resource));
        await fs.promises.mkdir(path.dirname(input), { recursive: true });
        await fs.promises.writeFile(input, desired[resource], { flag: "wx" });
        await this.tool.replace(stageIndex, bundleRoot(clientRoot), stageBundles, resource, input);
      }

      for (const resource of ENHANCEMENT_RESOURCES) {
        const output = path.join(stageRoot, "verify", resourceFileName(resource));
        await this.tool.extract(stageIndex, bundleRoot(clientRoot), stageBundles, resource, output);
        if ((await sha256File(output)) !== resourceSha256[resource]) {
          throw new Error(`增强补丁暂存区回读失败: ${resource}`);
        }
      }

      const customAfter = await this.tool.listCustomBundles(stageIndex);
      const bundleCandidates = [...new Set([
        ...stagedRelatives.filter((item) => item !== INDEX_RELATIVE),
        ...customAfter.map((item) => `Bundles2/${slash(item)}`),
      ])];
      const replacements: ReplacementFile[] = [];
      for (const relative of bundleCandidates) {
        const changed = await this.changedReplacement(clientRoot, stageRoot, relative);
        if (changed) replacements.push(changed);
      }
      const indexReplacement = await this.changedReplacement(clientRoot, stageRoot, INDEX_RELATIVE);
      if (indexReplacement) replacements.push(indexReplacement);
      if (!replacements.length) throw new Error("目标资源发生变化，但未找到需要提交的 Bundle 文件");

      await this.writeOperationMarker(
        kind,
        clientRoot,
        prepared.manifest.id,
        prepared.current.executableSha256,
        resourceSha256,
      );
      await this.commitSafe(clientRoot, replacements, prepared.current.executableSha256);
      await replaceFilesTransaction(clientRoot, replacements);

      const live = await this.currentResources(clientRoot);
      if (!allHashesMatch(live.hashes, resourceSha256)) throw new Error("增强补丁写入后资源回读校验失败");
      return {
        baselineId: prepared.manifest.id,
        executableSha256: prepared.current.executableSha256,
        resourceSha256,
        changed: true,
      };
    } finally {
      await fs.promises.rm(stageRoot, { recursive: true, force: true });
    }
  }

  async apply(
    clientRoot: string,
    state: ClientEnhancementState,
    config: ClientEnhancementConfig,
  ): Promise<EnhancementPatchResult> {
    const prepared = await this.prepareBaseline(clientRoot, state);
    const clean = await this.baselineBuffers(prepared, "clean");
    const desired = this.desiredResources(clean, config);
    const result = await this.writeResources(clientRoot, prepared, desired, "apply");
    this.log("客户端增强设置已应用并完成回读校验");
    return result;
  }

  /**
   * 强制以「当前客户端」为基准重建只读基线备份（重置增强基线）。
   * 用于初始备份有问题、或想重新以现在状态为还原基准时。把当前资源存为 original，
   * 并由此生成去掉增强的 clean 版本；旧的基线目录保留，不会被删除覆盖。
   */
  async resetBaseline(clientRoot: string): Promise<{ baselineId: string; baselineDir: string; executableSha256: string }> {
    await this.assertClientSafe(clientRoot);
    const current = await this.currentResources(clientRoot);
    const created = await this.createBaseline(clientRoot, current);
    return { baselineId: created.manifest.id, baselineDir: created.dir, executableSha256: current.executableSha256 };
  }

  async restore(clientRoot: string, state: ClientEnhancementState): Promise<EnhancementPatchResult> {
    const prepared = await this.prepareBaseline(clientRoot, state);
    const original = await this.baselineBuffers(prepared, "original");
    const result = await this.writeResources(clientRoot, prepared, original, "restore");
    this.log("客户端增强资源已恢复到首次修改前状态");
    return result;
  }
}
