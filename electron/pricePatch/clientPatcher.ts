import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { resolvePath } from "../engine/configStore";
import { cleanLocalizedBaseItems, patchLocalizedBaseItems } from "./dat64";
import { PoeBundleTool } from "./bundleTool";
import { detectPoeClient, isGameRunning, isPoeClientRoot, normalizePoeClientRoot } from "./clientLocator";
import {
  assertFilesStable,
  fingerprintFile,
  recoverInterruptedTransactions,
  replaceFilesTransaction,
  resolveInside,
  sha256File,
  type ReplacementFile,
} from "./fileSafety";
import type { AppliedFileFingerprint, PricePatchState, PriceSnapshot } from "./types";

const INDEX_RELATIVE = "Bundles2/_.index.bin";
const ENGLISH_RESOURCE = "Data/BaseItemTypes.datc64";
const LOCALIZED_RESOURCE = "Data/Simplified Chinese/BaseItemTypes.datc64";
const MIN_MATCHED_ITEMS = 10;

interface BaselineFile {
  relativePath: string;
  backupPath: string;
  size: number;
  sha256: string;
}

interface BaselineResource {
  backupPath: string;
  size: number;
  sha256: string;
}

interface ClientSignature {
  executableSha256: string;
  englishBaseItemsSha256: string;
}

interface BaselineManifest {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  clientRoot: string;
  sourceSignature: ClientSignature;
  originalFiles: BaselineFile[];
  restoreFiles: BaselineFile[];
  resources: {
    english: BaselineResource;
    localized: BaselineResource;
    originalLocalized?: BaselineResource;
  };
  cleanedPreviousPricePatch: boolean;
}

interface CurrentResources {
  english: Buffer;
  localized: Buffer;
  englishSha256: string;
  localizedSha256: string;
  signature: ClientSignature;
  customBundles: string[];
}

interface PreparedBaseline {
  manifest: BaselineManifest;
  baselineDir: string;
  current: CurrentResources;
  changed: boolean;
}

interface OperationMarker {
  schemaVersion: 1;
  kind: "apply" | "restore";
  clientRoot: string;
  baselineId: string;
  patchedResourceSha256: string;
  createdAt: string;
}

export interface ApplyPatchResult {
  baselineId: string;
  appliedFiles: AppliedFileFingerprint[];
  appliedCustomFiles: string[];
  patchedResourceSha256: string;
  matchedCount: number;
  skipped: boolean;
}

export interface RestorePatchResult {
  baselineId: string;
  restored: boolean;
}

export class GameRunningError extends Error {
  constructor() {
    super("游戏正在运行");
    this.name = "GameRunningError";
  }
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameSignature(a: ClientSignature, b: ClientSignature): boolean {
  return a.executableSha256 === b.executableSha256 && a.englishBaseItemsSha256 === b.englishBaseItemsSha256;
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
  const temp = `${file}.tmp`;
  await fs.promises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.promises.rename(temp, file);
}

function safeBaselineId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function bundleRoot(clientRoot: string): string {
  return path.join(clientRoot, "Bundles2");
}

function livePath(clientRoot: string, relativePath: string): string {
  return resolveInside(path.resolve(clientRoot), relativePath);
}

function backupAbsolute(baselineDir: string, file: BaselineFile | BaselineResource): string {
  return resolveInside(path.resolve(baselineDir), file.backupPath);
}

export class ClientPricePatcher {
  private readonly patchRoot: string;
  private readonly operationMarker: string;

  constructor(
    private readonly tool = new PoeBundleTool(),
    private readonly locateClient: (lastKnown?: string) => Promise<string> = detectPoeClient,
    private readonly gameRunning: () => Promise<boolean> = isGameRunning,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.patchRoot = resolvePath("price-patch");
    this.operationMarker = path.join(this.patchRoot, "last-operation.json");
  }

  async clientRoot(lastKnown = ""): Promise<string> {
    // 配置里有明确路径时必须使用它；路径失效应直接报错，不能误改另一份自动探测到的客户端。
    const root = lastKnown ? normalizePoeClientRoot(lastKnown) : await this.locateClient();
    if (!isPoeClientRoot(root)) throw new Error("国服客户端目录不完整");
    return path.resolve(root);
  }

  private async assertClientSafe(clientRoot: string): Promise<void> {
    if (await this.gameRunning()) throw new GameRunningError();
    const bundles = bundleRoot(clientRoot);
    await recoverInterruptedTransactions(clientRoot);
    const index = livePath(clientRoot, INDEX_RELATIVE);
    const [customBundles, resourceBundles] = await Promise.all([
      this.tool.listCustomBundles(index),
      this.tool.resourceBundles(index, [ENGLISH_RESOURCE, LOCALIZED_RESOURCE]),
    ]);
    const related = [...new Set([...customBundles, ...resourceBundles])]
      .map((item) => livePath(clientRoot, `Bundles2/${slash(item)}`))
      .filter(fs.existsSync);
    await assertFilesStable([index, ...related], 1500);
    const writable = [
      index,
      ...customBundles
        .map((item) => livePath(clientRoot, `Bundles2/${slash(item)}`))
        .filter(fs.existsSync),
    ];
    await this.tool.probeExclusive(writable);
    const probe = path.join(bundles, `.poecrafting-write-probe-${randomUUID()}`);
    const handle = await fs.promises.open(probe, "wx");
    await handle.close();
    await fs.promises.unlink(probe);
    if (await this.gameRunning()) throw new GameRunningError();
  }

  private tempDir(label: string): string {
    return path.join(this.patchRoot, "tmp", `${label}-${randomUUID()}`);
  }

  private async currentResources(clientRoot: string): Promise<CurrentResources> {
    const temp = this.tempDir("inspect");
    const englishFile = path.join(temp, "english.datc64");
    const localizedFile = path.join(temp, "localized.datc64");
    const index = livePath(clientRoot, INDEX_RELATIVE);
    const bundles = bundleRoot(clientRoot);
    try {
      const customBundles = await this.tool.extract(index, bundles, bundles, ENGLISH_RESOURCE, englishFile);
      await this.tool.extract(index, bundles, bundles, LOCALIZED_RESOURCE, localizedFile);
      const english = await fs.promises.readFile(englishFile);
      const localized = await fs.promises.readFile(localizedFile);
      const englishSha256 = hashBuffer(english);
      return {
        english,
        localized,
        englishSha256,
        localizedSha256: hashBuffer(localized),
        signature: {
          executableSha256: await sha256File(path.join(clientRoot, "PathOfExile_x64.exe")),
          englishBaseItemsSha256: englishSha256,
        },
        customBundles,
      };
    } finally {
      await fs.promises.rm(temp, { recursive: true, force: true });
    }
  }

  private baselineDir(id: string): string {
    if (!safeBaselineId(id)) throw new Error("基线备份标识不合法");
    return path.join(this.patchRoot, "baselines", id);
  }

  private async readOperationMarker(clientRoot: string): Promise<OperationMarker | null> {
    try {
      const marker = JSON.parse(await fs.promises.readFile(this.operationMarker, "utf8")) as OperationMarker;
      if (
        marker.schemaVersion !== 1 ||
        (marker.kind !== "apply" && marker.kind !== "restore") ||
        !safeBaselineId(marker.baselineId) ||
        path.resolve(marker.clientRoot).toLocaleLowerCase("en-US") !== path.resolve(clientRoot).toLocaleLowerCase("en-US")
      ) {
        return null;
      }
      return marker;
    } catch {
      return null;
    }
  }

  private async writeOperationMarker(marker: Omit<OperationMarker, "schemaVersion" | "createdAt">): Promise<void> {
    await writeJson(this.operationMarker, {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      ...marker,
    } satisfies OperationMarker);
  }

  private async verifyFileRecord(baselineDir: string, file: BaselineFile | BaselineResource): Promise<void> {
    const source = backupAbsolute(baselineDir, file);
    const stat = await fs.promises.stat(source);
    if (!stat.isFile() || stat.size !== file.size || (await sha256File(source)) !== file.sha256) {
      throw new Error(`基线备份校验失败: ${file.backupPath}`);
    }
  }

  private async loadBaseline(id: string, clientRoot: string): Promise<{ manifest: BaselineManifest; dir: string }> {
    const dir = this.baselineDir(id);
    const manifestFile = path.join(dir, "manifest.json");
    const manifest = JSON.parse(await fs.promises.readFile(manifestFile, "utf8")) as BaselineManifest;
    if (manifest.schemaVersion !== 1 || manifest.id !== id) throw new Error("基线备份清单版本不受支持");
    if (path.resolve(manifest.clientRoot).toLocaleLowerCase("en-US") !== path.resolve(clientRoot).toLocaleLowerCase("en-US")) {
      throw new Error("基线备份不属于当前客户端");
    }
    const records = [
      ...manifest.originalFiles,
      ...manifest.restoreFiles,
      manifest.resources.english,
      manifest.resources.localized,
      ...(manifest.resources.originalLocalized ? [manifest.resources.originalLocalized] : []),
    ];
    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.backupPath)) continue;
      seen.add(record.backupPath);
      await this.verifyFileRecord(dir, record);
    }
    return { manifest, dir };
  }

  private async copyBackupFile(
    baselineTemp: string,
    source: string,
    backupPath: string,
    relativePath: string,
  ): Promise<BaselineFile> {
    const destination = resolveInside(baselineTemp, backupPath);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    const fingerprint = await fingerprintFile(destination, relativePath);
    return { ...fingerprint, backupPath: slash(backupPath) };
  }

  private async resourceRecord(baselineTemp: string, backupPath: string, content: Buffer): Promise<BaselineResource> {
    const destination = resolveInside(baselineTemp, backupPath);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, content, { flag: "wx" });
    const stat = await fs.promises.stat(destination);
    return { backupPath: slash(backupPath), size: stat.size, sha256: hashBuffer(content) };
  }

  private async snapshotFiles(
    baselineTemp: string,
    clientRoot: string,
    customBundles: string[],
    prefix: string,
  ): Promise<BaselineFile[]> {
    const paths = [INDEX_RELATIVE, ...customBundles.map((item) => `Bundles2/${slash(item)}`)];
    const files: BaselineFile[] = [];
    for (const relativePath of paths) {
      files.push(
        await this.copyBackupFile(
          baselineTemp,
          livePath(clientRoot, relativePath),
          `${prefix}/${relativePath}`,
          relativePath,
        ),
      );
    }
    return files;
  }

  private async filesFromSnapshot(
    baselineTemp: string,
    snapshotRoot: string,
    customBundles: string[],
  ): Promise<BaselineFile[]> {
    const relativePaths = [INDEX_RELATIVE, ...customBundles.map((item) => `Bundles2/${slash(item)}`)];
    const files: BaselineFile[] = [];
    for (const relativePath of relativePaths) {
      const backupPath = slash(path.relative(baselineTemp, livePath(snapshotRoot, relativePath)));
      const fp = await fingerprintFile(livePath(snapshotRoot, relativePath), relativePath);
      files.push({ ...fp, backupPath });
    }
    return files;
  }

  private async createBaseline(
    clientRoot: string,
    current: CurrentResources,
    previousState: PricePatchState,
  ): Promise<{ manifest: BaselineManifest; dir: string }> {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const id = `${stamp}-${current.signature.executableSha256.slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const finalDir = this.baselineDir(id);
    const temp = path.join(this.patchRoot, "baselines", `.building-${id}`);
    if (await exists(finalDir)) throw new Error("基线备份目录已存在，拒绝覆盖");
    await fs.promises.mkdir(temp, { recursive: true });
    try {
      const originalFiles = await this.snapshotFiles(temp, clientRoot, current.customBundles, "original");
      const englishResource = await this.resourceRecord(temp, "resources/english.datc64", current.english);
      const cleaned = cleanLocalizedBaseItems(current.localized);
      const marker = await this.readOperationMarker(clientRoot);
      const knownPatchedHashes = new Set(
        [previousState.lastPatchedResourceSha256, marker?.kind === "apply" ? marker.patchedResourceSha256 : ""].filter(Boolean),
      );
      const shouldClean = previousState.applied && cleaned.changedCount > 0 && knownPatchedHashes.has(current.localizedSha256);
      const localizedBaseline = shouldClean ? cleaned.buffer : current.localized;
      const localizedResource = await this.resourceRecord(temp, "resources/localized.datc64", localizedBaseline);
      const originalLocalized = shouldClean
        ? await this.resourceRecord(temp, "resources/original-localized.datc64", current.localized)
        : undefined;

      let restoreFiles = originalFiles;
      if (shouldClean) {
        const restoreRoot = path.join(temp, "restore");
        for (const file of originalFiles) {
          const destination = livePath(restoreRoot, file.relativePath);
          await fs.promises.mkdir(path.dirname(destination), { recursive: true });
          await fs.promises.copyFile(backupAbsolute(temp, file), destination, fs.constants.COPYFILE_EXCL);
        }
        const cleanInput = backupAbsolute(temp, localizedResource);
        const restoreBundles = bundleRoot(restoreRoot);
        const custom = await this.tool.replace(
          livePath(restoreRoot, INDEX_RELATIVE),
          bundleRoot(clientRoot),
          restoreBundles,
          LOCALIZED_RESOURCE,
          cleanInput,
        );
        restoreFiles = await this.filesFromSnapshot(temp, restoreRoot, custom);
      }

      const manifest: BaselineManifest = {
        schemaVersion: 1,
        id,
        createdAt: new Date().toISOString(),
        clientRoot,
        sourceSignature: current.signature,
        originalFiles,
        restoreFiles,
        resources: { english: englishResource, localized: localizedResource, originalLocalized },
        cleanedPreviousPricePatch: shouldClean,
      };
      await writeJson(path.join(temp, "manifest.json"), manifest);
      await fs.promises.mkdir(path.dirname(finalDir), { recursive: true });
      await fs.promises.rename(temp, finalDir);
      this.log(`已建立并校验客户端基线备份: ${id}`);
      return { manifest, dir: finalDir };
    } catch (error) {
      await fs.promises.rm(temp, { recursive: true, force: true });
      throw error;
    }
  }

  private async liveMatches(clientRoot: string, files: AppliedFileFingerprint[] | BaselineFile[]): Promise<boolean> {
    for (const file of files) {
      const target = livePath(clientRoot, file.relativePath);
      if (!(await exists(target))) return false;
      const stat = await fs.promises.stat(target);
      if (stat.size !== file.size || (await sha256File(target)) !== file.sha256) return false;
    }
    return true;
  }

  private async prepareBaseline(clientRoot: string, state: PricePatchState): Promise<PreparedBaseline> {
    await this.assertClientSafe(clientRoot);
    const current = await this.currentResources(clientRoot);
    const marker = await this.readOperationMarker(clientRoot);
    const baselineId = state.baselineId || marker?.baselineId || "";
    if (!baselineId) {
      const created = await this.createBaseline(clientRoot, current, state);
      return { manifest: created.manifest, baselineDir: created.dir, current, changed: true };
    }

    const loaded = await this.loadBaseline(baselineId, clientRoot);
    if (!sameSignature(loaded.manifest.sourceSignature, current.signature)) {
      this.log("检测到客户端版本变化，正在建立新的只读基线备份");
      const created = await this.createBaseline(clientRoot, current, state);
      return { manifest: created.manifest, baselineDir: created.dir, current, changed: true };
    }

    if (state.applied) {
      const appliedFilesMatch = state.appliedFiles.length > 0 && (await this.liveMatches(clientRoot, state.appliedFiles));
      if (!appliedFilesMatch) {
        const completedPendingApply =
          marker?.kind === "apply" &&
          marker.baselineId === loaded.manifest.id &&
          marker.patchedResourceSha256 === current.localizedSha256;
        const completedPendingRestore =
          marker?.kind === "restore" &&
          marker.baselineId === loaded.manifest.id &&
          (await this.liveMatches(clientRoot, loaded.manifest.restoreFiles));
        if (!completedPendingApply && !completedPendingRestore) {
          throw new Error("客户端文件在标价补丁应用后被其他程序修改；为避免覆盖，已停止操作");
        }
      }
    } else if (!(await this.liveMatches(clientRoot, loaded.manifest.restoreFiles))) {
      const completedPendingApply =
        marker?.kind === "apply" &&
        marker.baselineId === loaded.manifest.id &&
        marker.patchedResourceSha256 === current.localizedSha256;
      if (completedPendingApply) {
        return { manifest: loaded.manifest, baselineDir: loaded.dir, current, changed: false };
      }
      // 同一游戏版本下出现新的字体/资源修改时，把它作为新基线保留，不覆盖旧备份。
      const created = await this.createBaseline(clientRoot, current, state);
      return { manifest: created.manifest, baselineDir: created.dir, current, changed: true };
    }
    return { manifest: loaded.manifest, baselineDir: loaded.dir, current, changed: false };
  }

  private async copyRestoreSnapshot(prepared: PreparedBaseline, stageRoot: string): Promise<void> {
    for (const file of prepared.manifest.restoreFiles) {
      const destination = livePath(stageRoot, file.relativePath);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.copyFile(backupAbsolute(prepared.baselineDir, file), destination, fs.constants.COPYFILE_EXCL);
    }
  }

  private async commitSafe(clientRoot: string, relativePaths: string[]): Promise<void> {
    if (await this.gameRunning()) throw new GameRunningError();
    const existing = relativePaths.map((item) => livePath(clientRoot, item)).filter(fs.existsSync);
    if (existing.length) {
      await assertFilesStable(existing, 1500);
      await this.tool.probeExclusive(existing);
    }
    if (await this.gameRunning()) throw new GameRunningError();
  }

  private async assertVersionUnchanged(clientRoot: string, expected: ClientSignature): Promise<void> {
    const latest = await this.currentResources(clientRoot);
    if (!sameSignature(latest.signature, expected)) {
      throw new Error("客户端在准备补丁期间发生更新，已取消本次写入；下次将重新建立基线");
    }
    if (await this.gameRunning()) throw new GameRunningError();
  }

  async apply(clientRoot: string, state: PricePatchState, prices: PriceSnapshot): Promise<ApplyPatchResult> {
    const prepared = await this.prepareBaseline(clientRoot, state);
    const english = await fs.promises.readFile(backupAbsolute(prepared.baselineDir, prepared.manifest.resources.english));
    const localized = await fs.promises.readFile(backupAbsolute(prepared.baselineDir, prepared.manifest.resources.localized));
    const patched = patchLocalizedBaseItems(english, localized, prices.quotes);
    if (patched.matchedCount < MIN_MATCHED_ITEMS) {
      throw new Error(`只匹配到 ${patched.matchedCount} 个行情物品，已拒绝写入客户端`);
    }
    const patchedResourceSha256 = hashBuffer(patched.buffer);
    if (
      !prepared.changed &&
      state.applied &&
      state.lastPriceDigest === prices.digest &&
      state.lastPatchedResourceSha256 === patchedResourceSha256 &&
      prepared.current.localizedSha256 === patchedResourceSha256
    ) {
      return {
        baselineId: prepared.manifest.id,
        appliedFiles: state.appliedFiles,
        appliedCustomFiles: state.appliedCustomFiles,
        patchedResourceSha256,
        matchedCount: patched.matchedCount,
        skipped: true,
      };
    }

    const stageRoot = this.tempDir("apply");
    const patchedInput = path.join(stageRoot, "patched-baseitemtypes.datc64");
    try {
      await this.copyRestoreSnapshot(prepared, stageRoot);
      await fs.promises.writeFile(patchedInput, patched.buffer, { flag: "wx" });
      const stageBundles = bundleRoot(stageRoot);
      const custom = await this.tool.replace(
        livePath(stageRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        stageBundles,
        LOCALIZED_RESOURCE,
        patchedInput,
      );
      const verifyFile = path.join(stageRoot, "verify-localized.datc64");
      await this.tool.extract(
        livePath(stageRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        stageBundles,
        LOCALIZED_RESOURCE,
        verifyFile,
      );
      if ((await sha256File(verifyFile)) !== patchedResourceSha256) {
        throw new Error("补丁暂存区回读校验失败");
      }

      const customRelative = custom.map((item) => `Bundles2/${slash(item)}`);
      const replacements: ReplacementFile[] = customRelative.map((relativePath) => ({
        relativePath,
        sourcePath: livePath(stageRoot, relativePath),
      }));
      // 索引最后换入；索引生效前，新 Bundle 即使已经复制也不会被客户端引用。
      replacements.push({ relativePath: INDEX_RELATIVE, sourcePath: livePath(stageRoot, INDEX_RELATIVE) });
      await this.writeOperationMarker({
        kind: "apply",
        clientRoot,
        baselineId: prepared.manifest.id,
        patchedResourceSha256,
      });
      await this.commitSafe(clientRoot, replacements.map((item) => item.relativePath));
      await this.assertVersionUnchanged(clientRoot, prepared.current.signature);
      const appliedFiles = await replaceFilesTransaction(clientRoot, replacements);

      const liveVerify = path.join(stageRoot, "verify-live-localized.datc64");
      await this.tool.extract(
        livePath(clientRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        bundleRoot(clientRoot),
        LOCALIZED_RESOURCE,
        liveVerify,
      );
      if ((await sha256File(liveVerify)) !== patchedResourceSha256) {
        throw new Error("客户端写入后资源回读校验失败");
      }
      this.log(`标价补丁已应用：${patched.matchedCount} 个物品`);
      return {
        baselineId: prepared.manifest.id,
        appliedFiles,
        appliedCustomFiles: customRelative,
        patchedResourceSha256,
        matchedCount: patched.matchedCount,
        skipped: false,
      };
    } finally {
      await fs.promises.rm(stageRoot, { recursive: true, force: true });
    }
  }

  async restore(clientRoot: string, state: PricePatchState): Promise<RestorePatchResult> {
    const prepared = await this.prepareBaseline(clientRoot, state);
    if (await this.liveMatches(clientRoot, prepared.manifest.restoreFiles)) {
      return { baselineId: prepared.manifest.id, restored: false };
    }
    if (!state.applied && !prepared.changed) return { baselineId: prepared.manifest.id, restored: false };

    const replacements: ReplacementFile[] = [];
    const restoreRelative = new Set(prepared.manifest.restoreFiles.map((file) => file.relativePath));
    for (const file of prepared.manifest.restoreFiles.filter((item) => item.relativePath !== INDEX_RELATIVE)) {
      replacements.push({ relativePath: file.relativePath, sourcePath: backupAbsolute(prepared.baselineDir, file) });
    }
    const index = prepared.manifest.restoreFiles.find((file) => file.relativePath === INDEX_RELATIVE);
    if (!index) throw new Error("基线备份缺少客户端索引");
    replacements.push({ relativePath: index.relativePath, sourcePath: backupAbsolute(prepared.baselineDir, index) });
    const removals = state.appliedCustomFiles.filter((item) => !restoreRelative.has(item));
    await this.writeOperationMarker({
      kind: "restore",
      clientRoot,
      baselineId: prepared.manifest.id,
      patchedResourceSha256: "",
    });
    await this.commitSafe(clientRoot, [...replacements.map((item) => item.relativePath), ...removals]);
    await this.assertVersionUnchanged(clientRoot, prepared.current.signature);
    await replaceFilesTransaction(clientRoot, replacements, removals);

    if (!(await this.liveMatches(clientRoot, prepared.manifest.restoreFiles))) {
      throw new Error("恢复后客户端文件未通过基线校验");
    }
    const temp = this.tempDir("restore-verify");
    try {
      const localized = path.join(temp, "localized.datc64");
      await this.tool.extract(
        livePath(clientRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        bundleRoot(clientRoot),
        LOCALIZED_RESOURCE,
        localized,
      );
      if ((await sha256File(localized)) !== prepared.manifest.resources.localized.sha256) {
        throw new Error("恢复后 BaseItemTypes 未通过基线校验");
      }
    } finally {
      await fs.promises.rm(temp, { recursive: true, force: true });
    }
    this.log("标价补丁已取消，客户端已恢复到补丁前基线");
    return { baselineId: prepared.manifest.id, restored: true };
  }
}
