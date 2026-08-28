import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { resolvePath } from "../engine/configStore";
import {
  cleanLocalizedBaseItems,
  isPriceSuffixOnlyBaseItemVariant,
  patchLocalizedBaseItems,
} from "./dat64";
import {
  cleanLocalizedUniqueWords,
  isPriceSuffixOnlyUniqueWordsVariant,
  patchLocalizedUniqueWords,
} from "./uniqueWordsDat64";
import {
  cleanLocalizedNamedDat,
  isPriceSuffixOnlyNamedDatVariant,
  namedDatRowCount,
  patchLocalizedNamedDat,
  referencedRowIndexes,
  type NamedDatOptions,
} from "./namedDat64";
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
import type { AppliedFileFingerprint, PriceLabelMode, PricePatchState, PriceSnapshot } from "./types";

const INDEX_RELATIVE = "Bundles2/_.index.bin";
const ENGLISH_RESOURCE = "Data/BaseItemTypes.datc64";
const LOCALIZED_RESOURCE = "Data/Simplified Chinese/BaseItemTypes.datc64";
const ENGLISH_WORDS_RESOURCE = "Data/Words.datc64";
const LOCALIZED_WORDS_RESOURCE = "Data/Simplified Chinese/Words.datc64";
const UNIQUE_STASH_LAYOUT_RESOURCE = "Data/UniqueStashLayout.datc64";
type AuxiliaryResourceId = "gemEffects" | "incursionRooms" | "monsterVarieties";
interface AuxiliaryResourceSpec {
  id: AuxiliaryResourceId;
  label: string;
  englishResource: string;
  localizedResource: string;
  referenceResource?: string;
  namePointerOffset: number;
}
const AUXILIARY_RESOURCE_SPECS: readonly AuxiliaryResourceSpec[] = [
  {
    id: "gemEffects",
    label: "技能宝石",
    englishResource: "Data/GemEffects.datc64",
    localizedResource: "Data/Simplified Chinese/GemEffects.datc64",
    namePointerOffset: 8,
  },
  {
    id: "incursionRooms",
    label: "神庙房间",
    englishResource: "Data/IncursionRooms.datc64",
    localizedResource: "Data/Simplified Chinese/IncursionRooms.datc64",
    namePointerOffset: 8,
  },
  {
    id: "monsterVarieties",
    label: "可捕捉野兽",
    englishResource: "Data/MonsterVarieties.datc64",
    localizedResource: "Data/Simplified Chinese/MonsterVarieties.datc64",
    referenceResource: "Data/BestiaryCapturableMonsters.datc64",
    namePointerOffset: 260,
  },
];
const PRICE_RESOURCES = [
  ENGLISH_RESOURCE,
  LOCALIZED_RESOURCE,
  ENGLISH_WORDS_RESOURCE,
  LOCALIZED_WORDS_RESOURCE,
  UNIQUE_STASH_LAYOUT_RESOURCE,
  ...AUXILIARY_RESOURCE_SPECS.flatMap((spec) => [
    spec.englishResource,
    spec.localizedResource,
    ...(spec.referenceResource ? [spec.referenceResource] : []),
  ]),
];
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
  englishWordsSha256?: string;
  uniqueStashLayoutSha256?: string;
  auxiliarySourcesSha256?: string;
}

interface BaselineAuxiliaryResource {
  english: BaselineResource;
  localized: BaselineResource;
  reference?: BaselineResource;
  originalLocalized?: BaselineResource;
}

interface BaselineManifest {
  schemaVersion: 1 | 2 | 3;
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
    englishWords?: BaselineResource;
    localizedWords?: BaselineResource;
    uniqueStashLayout?: BaselineResource;
    originalLocalizedWords?: BaselineResource;
    auxiliary?: Partial<Record<AuxiliaryResourceId, BaselineAuxiliaryResource>>;
  };
  cleanedPreviousPricePatch: boolean;
}

interface CurrentAuxiliaryResource {
  english: Buffer;
  localized: Buffer;
  reference?: Buffer;
  englishSha256: string;
  localizedSha256: string;
  referenceSha256?: string;
}

interface CurrentResources {
  english: Buffer;
  localized: Buffer;
  englishWords: Buffer;
  localizedWords: Buffer;
  uniqueStashLayout: Buffer;
  englishSha256: string;
  localizedSha256: string;
  englishWordsSha256: string;
  localizedWordsSha256: string;
  uniqueStashLayoutSha256: string;
  auxiliary: Record<AuxiliaryResourceId, CurrentAuxiliaryResource>;
  auxiliaryLocalizedSha256: string;
  signature: ClientSignature;
  customBundles: string[];
  resourceBundles: string[];
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
  patchedUniqueWordsSha256?: string;
  patchedAuxiliarySha256?: string;
  createdAt: string;
}

export interface ApplyPatchResult {
  baselineId: string;
  appliedFiles: AppliedFileFingerprint[];
  appliedCustomFiles: string[];
  patchedResourceSha256: string;
  patchedUniqueWordsSha256: string;
  patchedAuxiliarySha256: string;
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

function hashNamedValues(values: Array<[string, string]>): string {
  return hashBuffer(Buffer.from(JSON.stringify([...values].sort(([a], [b]) => a.localeCompare(b, "en")))));
}

function auxiliarySourceDigest(resources: Record<AuxiliaryResourceId, CurrentAuxiliaryResource>): string {
  return hashNamedValues(AUXILIARY_RESOURCE_SPECS.flatMap((spec) => [
    [`${spec.id}:english`, resources[spec.id].englishSha256] as [string, string],
    ...(resources[spec.id].referenceSha256
      ? [[`${spec.id}:reference`, resources[spec.id].referenceSha256 as string] as [string, string]]
      : []),
  ]));
}

function auxiliaryLocalizedDigest(resources: Record<AuxiliaryResourceId, CurrentAuxiliaryResource>): string {
  return hashNamedValues(
    AUXILIARY_RESOURCE_SPECS.map((spec) => [spec.id, resources[spec.id].localizedSha256]),
  );
}

function auxiliaryOptions(spec: AuxiliaryResourceSpec, resource: CurrentAuxiliaryResource): NamedDatOptions {
  return {
    namePointerOffset: spec.namePointerOffset,
    rowIndexes: resource.reference
      ? referencedRowIndexes(resource.reference, namedDatRowCount(resource.english, spec.namePointerOffset))
      : undefined,
  };
}

function sameSignature(a: ClientSignature, b: ClientSignature): boolean {
  return (
    a.executableSha256 === b.executableSha256 &&
    a.englishBaseItemsSha256 === b.englishBaseItemsSha256 &&
    Boolean(a.englishWordsSha256) &&
    a.englishWordsSha256 === b.englishWordsSha256 &&
    Boolean(a.uniqueStashLayoutSha256) &&
    a.uniqueStashLayoutSha256 === b.uniqueStashLayoutSha256 &&
    Boolean(a.auxiliarySourcesSha256) &&
    a.auxiliarySourcesSha256 === b.auxiliarySourcesSha256
  );
}

function hasUniqueWordBaseline(manifest: BaselineManifest): boolean {
  return Boolean(
    manifest.resources.englishWords &&
      manifest.resources.localizedWords &&
      manifest.resources.uniqueStashLayout,
  );
}

function uniqueWordBaseline(manifest: BaselineManifest): {
  englishWords: BaselineResource;
  localizedWords: BaselineResource;
  uniqueStashLayout: BaselineResource;
} {
  const { englishWords, localizedWords, uniqueStashLayout } = manifest.resources;
  if (!englishWords || !localizedWords || !uniqueStashLayout) {
    throw new Error("唯一装备名称基线不完整");
  }
  return { englishWords, localizedWords, uniqueStashLayout };
}

function hasAuxiliaryBaseline(manifest: BaselineManifest): boolean {
  return AUXILIARY_RESOURCE_SPECS.every((spec) => {
    const resource = manifest.resources.auxiliary?.[spec.id];
    return Boolean(resource?.english && resource.localized && (!spec.referenceResource || resource.reference));
  });
}

function auxiliaryBaseline(manifest: BaselineManifest): Record<AuxiliaryResourceId, BaselineAuxiliaryResource> {
  if (!hasAuxiliaryBaseline(manifest)) throw new Error("扩展标价资源基线不完整");
  return Object.fromEntries(
    AUXILIARY_RESOURCE_SPECS.map((spec) => [spec.id, manifest.resources.auxiliary?.[spec.id]]),
  ) as Record<AuxiliaryResourceId, BaselineAuxiliaryResource>;
}

function baselineAuxiliaryLocalizedDigest(
  resources: Record<AuxiliaryResourceId, BaselineAuxiliaryResource>,
): string {
  return hashNamedValues(AUXILIARY_RESOURCE_SPECS.map((spec) => [spec.id, resources[spec.id].localized.sha256]));
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
      this.tool.resourceBundles(index, PRICE_RESOURCES),
    ]);
    const related = [...new Set([...customBundles, ...resourceBundles])]
      .map((item) => livePath(clientRoot, `Bundles2/${slash(item)}`))
      .filter(fs.existsSync);
    await assertFilesStable([index, ...related], 1500);
    const writable = [index, ...related];
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
    const englishWordsFile = path.join(temp, "english-words.datc64");
    const localizedWordsFile = path.join(temp, "localized-words.datc64");
    const uniqueStashLayoutFile = path.join(temp, "unique-stash-layout.datc64");
    const index = livePath(clientRoot, INDEX_RELATIVE);
    const bundles = bundleRoot(clientRoot);
    try {
      const customBundles = await this.tool.extract(index, bundles, bundles, ENGLISH_RESOURCE, englishFile);
      await this.tool.extract(index, bundles, bundles, LOCALIZED_RESOURCE, localizedFile);
      await this.tool.extract(index, bundles, bundles, ENGLISH_WORDS_RESOURCE, englishWordsFile);
      await this.tool.extract(index, bundles, bundles, LOCALIZED_WORDS_RESOURCE, localizedWordsFile);
      await this.tool.extract(index, bundles, bundles, UNIQUE_STASH_LAYOUT_RESOURCE, uniqueStashLayoutFile);
      for (const spec of AUXILIARY_RESOURCE_SPECS) {
        await this.tool.extract(
          index,
          bundles,
          bundles,
          spec.englishResource,
          path.join(temp, `${spec.id}-english.datc64`),
        );
        await this.tool.extract(
          index,
          bundles,
          bundles,
          spec.localizedResource,
          path.join(temp, `${spec.id}-localized.datc64`),
        );
        if ("referenceResource" in spec && spec.referenceResource) {
          await this.tool.extract(
            index,
            bundles,
            bundles,
            spec.referenceResource,
            path.join(temp, `${spec.id}-reference.datc64`),
          );
        }
      }
      const [english, localized, englishWords, localizedWords, uniqueStashLayout] = await Promise.all([
        fs.promises.readFile(englishFile),
        fs.promises.readFile(localizedFile),
        fs.promises.readFile(englishWordsFile),
        fs.promises.readFile(localizedWordsFile),
        fs.promises.readFile(uniqueStashLayoutFile),
      ]);
      const englishSha256 = hashBuffer(english);
      const englishWordsSha256 = hashBuffer(englishWords);
      const uniqueStashLayoutSha256 = hashBuffer(uniqueStashLayout);
      const auxiliary = Object.fromEntries(await Promise.all(AUXILIARY_RESOURCE_SPECS.map(async (spec) => {
        const englishAuxiliary = await fs.promises.readFile(path.join(temp, `${spec.id}-english.datc64`));
        const localizedAuxiliary = await fs.promises.readFile(path.join(temp, `${spec.id}-localized.datc64`));
        const reference = "referenceResource" in spec && spec.referenceResource
          ? await fs.promises.readFile(path.join(temp, `${spec.id}-reference.datc64`))
          : undefined;
        return [spec.id, {
          english: englishAuxiliary,
          localized: localizedAuxiliary,
          reference,
          englishSha256: hashBuffer(englishAuxiliary),
          localizedSha256: hashBuffer(localizedAuxiliary),
          referenceSha256: reference ? hashBuffer(reference) : undefined,
        }];
      }))) as Record<AuxiliaryResourceId, CurrentAuxiliaryResource>;
      const auxiliarySourcesSha256 = auxiliarySourceDigest(auxiliary);
      const resourceBundles = await this.tool.resourceBundles(index, PRICE_RESOURCES);
      return {
        english,
        localized,
        englishWords,
        localizedWords,
        uniqueStashLayout,
        englishSha256,
        localizedSha256: hashBuffer(localized),
        englishWordsSha256,
        localizedWordsSha256: hashBuffer(localizedWords),
        uniqueStashLayoutSha256,
        auxiliary,
        auxiliaryLocalizedSha256: auxiliaryLocalizedDigest(auxiliary),
        signature: {
          executableSha256: await sha256File(path.join(clientRoot, "PathOfExile_x64.exe")),
          englishBaseItemsSha256: englishSha256,
          englishWordsSha256,
          uniqueStashLayoutSha256,
          auxiliarySourcesSha256,
        },
        customBundles,
        resourceBundles,
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
    if ((manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2 && manifest.schemaVersion !== 3) || manifest.id !== id) {
      throw new Error("基线备份清单版本不受支持");
    }
    if (path.resolve(manifest.clientRoot).toLocaleLowerCase("en-US") !== path.resolve(clientRoot).toLocaleLowerCase("en-US")) {
      throw new Error("基线备份不属于当前客户端");
    }
    const records = [
      ...manifest.originalFiles,
      ...manifest.restoreFiles,
      manifest.resources.english,
      manifest.resources.localized,
      ...(manifest.resources.originalLocalized ? [manifest.resources.originalLocalized] : []),
      ...(manifest.resources.englishWords ? [manifest.resources.englishWords] : []),
      ...(manifest.resources.localizedWords ? [manifest.resources.localizedWords] : []),
      ...(manifest.resources.uniqueStashLayout ? [manifest.resources.uniqueStashLayout] : []),
      ...(manifest.resources.originalLocalizedWords ? [manifest.resources.originalLocalizedWords] : []),
      ...Object.values(manifest.resources.auxiliary || {}).flatMap((resource) => resource
        ? [
            resource.english,
            resource.localized,
            ...(resource.reference ? [resource.reference] : []),
            ...(resource.originalLocalized ? [resource.originalLocalized] : []),
          ]
        : []),
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
    acceptCompatiblePricePatch = false,
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
      const englishWordsResource = await this.resourceRecord(
        temp,
        "resources/english-words.datc64",
        current.englishWords,
      );
      const uniqueStashLayoutResource = await this.resourceRecord(
        temp,
        "resources/unique-stash-layout.datc64",
        current.uniqueStashLayout,
      );
      const cleanedBaseItems = cleanLocalizedBaseItems(current.localized);
      const cleanedUniqueWords = cleanLocalizedUniqueWords(current.localizedWords, current.uniqueStashLayout);
      const cleanedAuxiliary = Object.fromEntries(AUXILIARY_RESOURCE_SPECS.map((spec) => [
        spec.id,
        cleanLocalizedNamedDat(current.auxiliary[spec.id].localized, auxiliaryOptions(spec, current.auxiliary[spec.id])),
      ])) as Record<AuxiliaryResourceId, ReturnType<typeof cleanLocalizedNamedDat>>;
      const marker = await this.readOperationMarker(clientRoot);
      const knownPatchedBaseHashes = new Set(
        [previousState.lastPatchedResourceSha256, marker?.kind === "apply" ? marker.patchedResourceSha256 : ""].filter(Boolean),
      );
      const knownPatchedUniqueWordHashes = new Set(
        [
          previousState.lastPatchedUniqueWordsSha256,
          marker?.kind === "apply" ? marker.patchedUniqueWordsSha256 || "" : "",
        ].filter(Boolean),
      );
      const knownPatchedAuxiliaryHashes = new Set(
        [
          previousState.lastPatchedAuxiliarySha256,
          marker?.kind === "apply" ? marker.patchedAuxiliarySha256 || "" : "",
        ].filter(Boolean),
      );
      const shouldCleanBaseItems =
        previousState.applied &&
        cleanedBaseItems.changedCount > 0 &&
        (knownPatchedBaseHashes.has(current.localizedSha256) || acceptCompatiblePricePatch);
      const shouldCleanUniqueWords =
        previousState.applied &&
        cleanedUniqueWords.changedCount > 0 &&
        (knownPatchedUniqueWordHashes.has(current.localizedWordsSha256) || acceptCompatiblePricePatch);
      const shouldCleanAuxiliary =
        previousState.applied &&
        Object.values(cleanedAuxiliary).some((result) => result.changedCount > 0) &&
        (knownPatchedAuxiliaryHashes.has(current.auxiliaryLocalizedSha256) || acceptCompatiblePricePatch);
      const localizedBaseline = shouldCleanBaseItems ? cleanedBaseItems.buffer : current.localized;
      const localizedWordsBaseline = shouldCleanUniqueWords ? cleanedUniqueWords.buffer : current.localizedWords;
      const localizedResource = await this.resourceRecord(temp, "resources/localized.datc64", localizedBaseline);
      const localizedWordsResource = await this.resourceRecord(
        temp,
        "resources/localized-words.datc64",
        localizedWordsBaseline,
      );
      const originalLocalized = shouldCleanBaseItems
        ? await this.resourceRecord(temp, "resources/original-localized.datc64", current.localized)
        : undefined;
      const originalLocalizedWords = shouldCleanUniqueWords
        ? await this.resourceRecord(temp, "resources/original-localized-words.datc64", current.localizedWords)
        : undefined;
      const auxiliaryResources = Object.fromEntries(await Promise.all(AUXILIARY_RESOURCE_SPECS.map(async (spec) => {
        const currentResource = current.auxiliary[spec.id];
        const cleaned = cleanedAuxiliary[spec.id];
        const cleanThisResource = shouldCleanAuxiliary && cleaned.changedCount > 0;
        const englishAuxiliary = await this.resourceRecord(
          temp,
          `resources/${spec.id}-english.datc64`,
          currentResource.english,
        );
        const localizedAuxiliary = await this.resourceRecord(
          temp,
          `resources/${spec.id}-localized.datc64`,
          cleanThisResource ? cleaned.buffer : currentResource.localized,
        );
        const reference = currentResource.reference
          ? await this.resourceRecord(temp, `resources/${spec.id}-reference.datc64`, currentResource.reference)
          : undefined;
        const originalLocalizedAuxiliary = cleanThisResource
          ? await this.resourceRecord(
              temp,
              `resources/${spec.id}-original-localized.datc64`,
              currentResource.localized,
            )
          : undefined;
        return [spec.id, {
          english: englishAuxiliary,
          localized: localizedAuxiliary,
          reference,
          originalLocalized: originalLocalizedAuxiliary,
        }];
      }))) as Record<AuxiliaryResourceId, BaselineAuxiliaryResource>;

      let restoreFiles = originalFiles;
      if (shouldCleanBaseItems || shouldCleanUniqueWords || shouldCleanAuxiliary) {
        const restoreRoot = path.join(temp, "restore");
        for (const file of originalFiles) {
          const destination = livePath(restoreRoot, file.relativePath);
          await fs.promises.mkdir(path.dirname(destination), { recursive: true });
          await fs.promises.copyFile(backupAbsolute(temp, file), destination, fs.constants.COPYFILE_EXCL);
        }
        const restoreBundles = bundleRoot(restoreRoot);
        const customBundles: string[] = [];
        if (shouldCleanBaseItems) {
          customBundles.push(
            ...(await this.tool.replace(
              livePath(restoreRoot, INDEX_RELATIVE),
              bundleRoot(clientRoot),
              restoreBundles,
              LOCALIZED_RESOURCE,
              backupAbsolute(temp, localizedResource),
            )),
          );
        }
        if (shouldCleanUniqueWords) {
          customBundles.push(
            ...(await this.tool.replace(
              livePath(restoreRoot, INDEX_RELATIVE),
              bundleRoot(clientRoot),
              restoreBundles,
              LOCALIZED_WORDS_RESOURCE,
              backupAbsolute(temp, localizedWordsResource),
            )),
          );
        }
        if (shouldCleanAuxiliary) {
          for (const spec of AUXILIARY_RESOURCE_SPECS) {
            const resource = auxiliaryResources[spec.id];
            if (!resource.originalLocalized) continue;
            customBundles.push(
              ...(await this.tool.replace(
                livePath(restoreRoot, INDEX_RELATIVE),
                bundleRoot(clientRoot),
                restoreBundles,
                spec.localizedResource,
                backupAbsolute(temp, resource.localized),
              )),
            );
          }
        }
        restoreFiles = await this.filesFromSnapshot(temp, restoreRoot, [...new Set(customBundles)]);
      }

      const manifest: BaselineManifest = {
        schemaVersion: 3,
        id,
        createdAt: new Date().toISOString(),
        clientRoot,
        sourceSignature: current.signature,
        originalFiles,
        restoreFiles,
        resources: {
          english: englishResource,
          localized: localizedResource,
          originalLocalized,
          englishWords: englishWordsResource,
          localizedWords: localizedWordsResource,
          uniqueStashLayout: uniqueStashLayoutResource,
          originalLocalizedWords,
          auxiliary: auxiliaryResources,
        },
        cleanedPreviousPricePatch: shouldCleanBaseItems || shouldCleanUniqueWords || shouldCleanAuxiliary,
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
    if (!hasUniqueWordBaseline(loaded.manifest)) {
      const legacySignatureMatches =
        loaded.manifest.sourceSignature.executableSha256 === current.signature.executableSha256 &&
        loaded.manifest.sourceSignature.englishBaseItemsSha256 === current.signature.englishBaseItemsSha256;
      if (legacySignatureMatches && state.applied) {
        const knownAppliedBase =
          (Boolean(state.lastPatchedResourceSha256) &&
            state.lastPatchedResourceSha256 === current.localizedSha256) ||
          (marker?.kind === "apply" && marker.patchedResourceSha256 === current.localizedSha256) ||
          current.localizedSha256 === loaded.manifest.resources.localized.sha256;
        let compatiblePricePatch = false;
        if (!knownAppliedBase) {
          const legacyLocalized = await fs.promises.readFile(
            backupAbsolute(loaded.dir, loaded.manifest.resources.localized),
          );
          compatiblePricePatch = isPriceSuffixOnlyBaseItemVariant(legacyLocalized, current.localized);
          if (!compatiblePricePatch) {
            throw new Error("BaseItemTypes 在旧版标价补丁应用后发生了无法验证的修改；为避免覆盖，已停止升级基线");
          }
          this.log("检测到另一份 POE Tools 生成的兼容标价资源，正在安全接管并升级基线");
        }
        this.log("正在升级标价基线，加入唯一装备名称资源");
        const created = await this.createBaseline(clientRoot, current, state, compatiblePricePatch);
        return { manifest: created.manifest, baselineDir: created.dir, current, changed: true };
      }
      this.log("正在升级标价基线，加入唯一装备名称资源");
      const created = await this.createBaseline(clientRoot, current, state);
      return { manifest: created.manifest, baselineDir: created.dir, current, changed: true };
    }

    if (!hasAuxiliaryBaseline(loaded.manifest)) {
      const legacySignatureMatches =
        loaded.manifest.sourceSignature.executableSha256 === current.signature.executableSha256 &&
        loaded.manifest.sourceSignature.englishBaseItemsSha256 === current.signature.englishBaseItemsSha256 &&
        loaded.manifest.sourceSignature.englishWordsSha256 === current.signature.englishWordsSha256 &&
        loaded.manifest.sourceSignature.uniqueStashLayoutSha256 === current.signature.uniqueStashLayoutSha256;
      if (legacySignatureMatches && state.applied) {
        const uniqueResources = uniqueWordBaseline(loaded.manifest);
        const [baselineLocalized, baselineLocalizedWords] = await Promise.all([
          fs.promises.readFile(backupAbsolute(loaded.dir, loaded.manifest.resources.localized)),
          fs.promises.readFile(backupAbsolute(loaded.dir, uniqueResources.localizedWords)),
        ]);
        const compatibleBaseItems =
          current.localizedSha256 === loaded.manifest.resources.localized.sha256 ||
          isPriceSuffixOnlyBaseItemVariant(baselineLocalized, current.localized);
        const compatibleUniqueWords =
          current.localizedWordsSha256 === uniqueResources.localizedWords.sha256 ||
          isPriceSuffixOnlyUniqueWordsVariant(baselineLocalizedWords, current.localizedWords, current.uniqueStashLayout);
        if (!compatibleBaseItems || !compatibleUniqueWords) {
          throw new Error("旧版标价资源发生了无法验证的修改；为避免覆盖，已停止升级基线");
        }
        this.log("正在升级标价基线，加入技能宝石、神庙房间和可捕捉野兽名称资源");
        const created = await this.createBaseline(clientRoot, current, state, true);
        return { manifest: created.manifest, baselineDir: created.dir, current, changed: true };
      }
      this.log("正在升级标价基线，加入技能宝石、神庙房间和可捕捉野兽名称资源");
      const created = await this.createBaseline(clientRoot, current, state);
      return { manifest: created.manifest, baselineDir: created.dir, current, changed: true };
    }

    if (!sameSignature(loaded.manifest.sourceSignature, current.signature)) {
      this.log("检测到客户端版本变化，正在建立新的只读基线备份");
      const created = await this.createBaseline(clientRoot, current, state);
      return { manifest: created.manifest, baselineDir: created.dir, current, changed: true };
    }

    const uniqueResources = uniqueWordBaseline(loaded.manifest);
    const auxiliaryResources = auxiliaryBaseline(loaded.manifest);
    const baselineAuxiliarySha256 = baselineAuxiliaryLocalizedDigest(auxiliaryResources);
    if (state.applied) {
      const patchedResourcesMatch =
        Boolean(state.lastPatchedResourceSha256) &&
        current.localizedSha256 === state.lastPatchedResourceSha256 &&
        Boolean(state.lastPatchedUniqueWordsSha256) &&
        current.localizedWordsSha256 === state.lastPatchedUniqueWordsSha256 &&
        Boolean(state.lastPatchedAuxiliarySha256) &&
        current.auxiliaryLocalizedSha256 === state.lastPatchedAuxiliarySha256;
      if (!patchedResourcesMatch) {
        const completedPendingApply =
          marker?.kind === "apply" &&
          marker.baselineId === loaded.manifest.id &&
          marker.patchedResourceSha256 === current.localizedSha256 &&
          Boolean(marker.patchedUniqueWordsSha256) &&
          marker.patchedUniqueWordsSha256 === current.localizedWordsSha256 &&
          Boolean(marker.patchedAuxiliarySha256) &&
          marker.patchedAuxiliarySha256 === current.auxiliaryLocalizedSha256;
        const completedPendingRestore =
          marker?.kind === "restore" &&
          marker.baselineId === loaded.manifest.id &&
          current.localizedSha256 === loaded.manifest.resources.localized.sha256 &&
          current.localizedWordsSha256 === uniqueResources.localizedWords.sha256 &&
          current.auxiliaryLocalizedSha256 === baselineAuxiliarySha256;
        if (!completedPendingApply && !completedPendingRestore) {
          const [baselineLocalized, baselineLocalizedWords] = await Promise.all([
            fs.promises.readFile(backupAbsolute(loaded.dir, loaded.manifest.resources.localized)),
            fs.promises.readFile(backupAbsolute(loaded.dir, uniqueResources.localizedWords)),
          ]);
          const compatibleBaseItems =
            current.localizedSha256 === loaded.manifest.resources.localized.sha256 ||
            isPriceSuffixOnlyBaseItemVariant(baselineLocalized, current.localized);
          const compatibleUniqueWords =
            current.localizedWordsSha256 === uniqueResources.localizedWords.sha256 ||
            isPriceSuffixOnlyUniqueWordsVariant(
              baselineLocalizedWords,
              current.localizedWords,
              current.uniqueStashLayout,
            );
          const compatibleAuxiliary = (await Promise.all(AUXILIARY_RESOURCE_SPECS.map(async (spec) => {
            const baselineResource = auxiliaryResources[spec.id];
            if (current.auxiliary[spec.id].localizedSha256 === baselineResource.localized.sha256) return true;
            const baselineLocalizedAuxiliary = await fs.promises.readFile(
              backupAbsolute(loaded.dir, baselineResource.localized),
            );
            return isPriceSuffixOnlyNamedDatVariant(
              baselineLocalizedAuxiliary,
              current.auxiliary[spec.id].localized,
              auxiliaryOptions(spec, current.auxiliary[spec.id]),
            );
          }))).every(Boolean);
          if (!compatibleBaseItems || !compatibleUniqueWords || !compatibleAuxiliary) {
            throw new Error("标价资源在补丁应用后发生了无法验证的修改；为避免覆盖，已停止操作");
          }
          this.log("检测到另一份 POE Tools 生成的兼容标价资源，正在安全接管当前状态");
          const created = await this.createBaseline(clientRoot, current, state, true);
          return { manifest: created.manifest, baselineDir: created.dir, current, changed: true };
        }
      }
    } else if (
      current.localizedSha256 !== loaded.manifest.resources.localized.sha256 ||
      current.localizedWordsSha256 !== uniqueResources.localizedWords.sha256 ||
      current.auxiliaryLocalizedSha256 !== baselineAuxiliarySha256
    ) {
      const completedPendingApply =
        marker?.kind === "apply" &&
        marker.baselineId === loaded.manifest.id &&
        marker.patchedResourceSha256 === current.localizedSha256 &&
        Boolean(marker.patchedUniqueWordsSha256) &&
        marker.patchedUniqueWordsSha256 === current.localizedWordsSha256 &&
        Boolean(marker.patchedAuxiliarySha256) &&
        marker.patchedAuxiliarySha256 === current.auxiliaryLocalizedSha256;
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

  /**
   * 从当前客户端复制暂存区，只替换标价所需的名称资源。
   * 这样标价更新不会把同一 Bundle 内的视距、小地图或其他第三方资源修改回滚掉。
   */
  private async copyCurrentSnapshot(
    prepared: PreparedBaseline,
    clientRoot: string,
    stageRoot: string,
  ): Promise<string[]> {
    const bundles = [...new Set([...prepared.current.customBundles, ...prepared.current.resourceBundles])]
      .map((item) => `Bundles2/${slash(item)}`);
    const relatives = [INDEX_RELATIVE, ...bundles];
    for (const relativePath of relatives) {
      const destination = livePath(stageRoot, relativePath);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.copyFile(livePath(clientRoot, relativePath), destination, fs.constants.COPYFILE_EXCL);
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

  async apply(
    clientRoot: string,
    state: PricePatchState,
    prices: PriceSnapshot,
    labelMode: PriceLabelMode = state.labelMode,
  ): Promise<ApplyPatchResult> {
    const prepared = await this.prepareBaseline(clientRoot, state);
    const uniqueResources = uniqueWordBaseline(prepared.manifest);
    const auxiliaryResources = auxiliaryBaseline(prepared.manifest);
    const [english, localized, englishWords, localizedWords, uniqueStashLayout] = await Promise.all([
      fs.promises.readFile(backupAbsolute(prepared.baselineDir, prepared.manifest.resources.english)),
      fs.promises.readFile(backupAbsolute(prepared.baselineDir, prepared.manifest.resources.localized)),
      fs.promises.readFile(backupAbsolute(prepared.baselineDir, uniqueResources.englishWords)),
      fs.promises.readFile(backupAbsolute(prepared.baselineDir, uniqueResources.localizedWords)),
      fs.promises.readFile(backupAbsolute(prepared.baselineDir, uniqueResources.uniqueStashLayout)),
    ]);
    const patchedBaseItems = patchLocalizedBaseItems(english, localized, prices.quotes, labelMode);
    const patchedUniqueWords = patchLocalizedUniqueWords(
      englishWords,
      localizedWords,
      uniqueStashLayout,
      prices.quotes,
      labelMode,
    );
    const patchedAuxiliary = Object.fromEntries(await Promise.all(AUXILIARY_RESOURCE_SPECS.map(async (spec) => {
      const baselineResource = auxiliaryResources[spec.id];
      const [englishAuxiliary, localizedAuxiliary, reference] = await Promise.all([
        fs.promises.readFile(backupAbsolute(prepared.baselineDir, baselineResource.english)),
        fs.promises.readFile(backupAbsolute(prepared.baselineDir, baselineResource.localized)),
        baselineResource.reference
          ? fs.promises.readFile(backupAbsolute(prepared.baselineDir, baselineResource.reference))
          : Promise.resolve(undefined),
      ]);
      const options: NamedDatOptions = {
        namePointerOffset: spec.namePointerOffset,
        rowIndexes: reference
          ? referencedRowIndexes(reference, namedDatRowCount(englishAuxiliary, spec.namePointerOffset))
          : undefined,
      };
      return [spec.id, patchLocalizedNamedDat(englishAuxiliary, localizedAuxiliary, prices.quotes, options, labelMode)];
    }))) as Record<AuxiliaryResourceId, ReturnType<typeof patchLocalizedNamedDat>>;
    const auxiliaryMatchedCount = Object.values(patchedAuxiliary)
      .reduce((total, result) => total + result.matchedCount, 0);
    const matchedCount = patchedBaseItems.matchedCount + patchedUniqueWords.matchedCount + auxiliaryMatchedCount;
    if (matchedCount < MIN_MATCHED_ITEMS) {
      throw new Error(`只匹配到 ${matchedCount} 个行情物品，已拒绝写入客户端`);
    }
    const patchedResourceSha256 = hashBuffer(patchedBaseItems.buffer);
    const patchedUniqueWordsSha256 = hashBuffer(patchedUniqueWords.buffer);
    const patchedAuxiliaryHashes = Object.fromEntries(AUXILIARY_RESOURCE_SPECS.map((spec) => [
      spec.id,
      hashBuffer(patchedAuxiliary[spec.id].buffer),
    ])) as Record<AuxiliaryResourceId, string>;
    const patchedAuxiliarySha256 = hashNamedValues(
      AUXILIARY_RESOURCE_SPECS.map((spec) => [spec.id, patchedAuxiliaryHashes[spec.id]]),
    );
    if (
      !prepared.changed &&
      state.applied &&
      state.lastPriceDigest === prices.digest &&
      state.lastPatchedResourceSha256 === patchedResourceSha256 &&
      state.lastPatchedUniqueWordsSha256 === patchedUniqueWordsSha256 &&
      state.lastPatchedAuxiliarySha256 === patchedAuxiliarySha256 &&
      prepared.current.localizedSha256 === patchedResourceSha256 &&
      prepared.current.localizedWordsSha256 === patchedUniqueWordsSha256 &&
      prepared.current.auxiliaryLocalizedSha256 === patchedAuxiliarySha256
    ) {
      return {
        baselineId: prepared.manifest.id,
        appliedFiles: state.appliedFiles,
        appliedCustomFiles: state.appliedCustomFiles,
        patchedResourceSha256,
        patchedUniqueWordsSha256,
        patchedAuxiliarySha256,
        matchedCount,
        skipped: true,
      };
    }

    const stageRoot = this.tempDir("apply");
    const patchedBaseItemsInput = path.join(stageRoot, "patched-baseitemtypes.datc64");
    const patchedUniqueWordsInput = path.join(stageRoot, "patched-unique-words.datc64");
    const patchedAuxiliaryInputs = Object.fromEntries(AUXILIARY_RESOURCE_SPECS.map((spec) => [
      spec.id,
      path.join(stageRoot, `patched-${spec.id}.datc64`),
    ])) as Record<AuxiliaryResourceId, string>;
    try {
      const stagedRelatives = await this.copyCurrentSnapshot(prepared, clientRoot, stageRoot);
      await Promise.all([
        fs.promises.writeFile(patchedBaseItemsInput, patchedBaseItems.buffer, { flag: "wx" }),
        fs.promises.writeFile(patchedUniqueWordsInput, patchedUniqueWords.buffer, { flag: "wx" }),
        ...AUXILIARY_RESOURCE_SPECS.map((spec) => fs.promises.writeFile(
          patchedAuxiliaryInputs[spec.id],
          patchedAuxiliary[spec.id].buffer,
          { flag: "wx" },
        )),
      ]);
      const stageBundles = bundleRoot(stageRoot);
      const customBundles = await this.tool.replace(
        livePath(stageRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        stageBundles,
        LOCALIZED_RESOURCE,
        patchedBaseItemsInput,
      );
      customBundles.push(
        ...(await this.tool.replace(
          livePath(stageRoot, INDEX_RELATIVE),
          bundleRoot(clientRoot),
          stageBundles,
          LOCALIZED_WORDS_RESOURCE,
          patchedUniqueWordsInput,
        )),
      );
      for (const spec of AUXILIARY_RESOURCE_SPECS) {
        customBundles.push(
          ...(await this.tool.replace(
            livePath(stageRoot, INDEX_RELATIVE),
            bundleRoot(clientRoot),
            stageBundles,
            spec.localizedResource,
            patchedAuxiliaryInputs[spec.id],
          )),
        );
      }
      const verifyBaseItems = path.join(stageRoot, "verify-localized.datc64");
      const verifyUniqueWords = path.join(stageRoot, "verify-localized-words.datc64");
      const verifyAuxiliary = Object.fromEntries(AUXILIARY_RESOURCE_SPECS.map((spec) => [
        spec.id,
        path.join(stageRoot, `verify-${spec.id}.datc64`),
      ])) as Record<AuxiliaryResourceId, string>;
      await this.tool.extract(
        livePath(stageRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        stageBundles,
        LOCALIZED_RESOURCE,
        verifyBaseItems,
      );
      await this.tool.extract(
        livePath(stageRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        stageBundles,
        LOCALIZED_WORDS_RESOURCE,
        verifyUniqueWords,
      );
      for (const spec of AUXILIARY_RESOURCE_SPECS) {
        await this.tool.extract(
          livePath(stageRoot, INDEX_RELATIVE),
          bundleRoot(clientRoot),
          stageBundles,
          spec.localizedResource,
          verifyAuxiliary[spec.id],
        );
      }
      if (
        (await sha256File(verifyBaseItems)) !== patchedResourceSha256 ||
        (await sha256File(verifyUniqueWords)) !== patchedUniqueWordsSha256 ||
        !(await Promise.all(AUXILIARY_RESOURCE_SPECS.map(async (spec) =>
          (await sha256File(verifyAuxiliary[spec.id])) === patchedAuxiliaryHashes[spec.id],
        ))).every(Boolean)
      ) {
        throw new Error("标价补丁暂存区回读校验失败");
      }

      const customRelative = [...new Set(customBundles)].map((item) => `Bundles2/${slash(item)}`);
      const candidates = [...new Set([
        ...stagedRelatives.filter((item) => item !== INDEX_RELATIVE),
        ...customRelative,
      ])];
      const replacements: ReplacementFile[] = [];
      for (const relativePath of candidates) {
        const changed = await this.changedReplacement(clientRoot, stageRoot, relativePath);
        if (changed) replacements.push(changed);
      }
      // 索引最后换入；索引生效前，新 Bundle 即使已经复制也不会被客户端引用。
      const indexReplacement = await this.changedReplacement(clientRoot, stageRoot, INDEX_RELATIVE);
      if (indexReplacement) replacements.push(indexReplacement);
      if (!replacements.length) throw new Error("标价资源已变化，但未找到需要提交的 Bundle 文件");
      await this.writeOperationMarker({
        kind: "apply",
        clientRoot,
        baselineId: prepared.manifest.id,
        patchedResourceSha256,
        patchedUniqueWordsSha256,
        patchedAuxiliarySha256,
      });
      await this.commitSafe(clientRoot, replacements.map((item) => item.relativePath));
      await this.assertVersionUnchanged(clientRoot, prepared.current.signature);
      const appliedFiles = await replaceFilesTransaction(clientRoot, replacements);

      const liveVerifyBaseItems = path.join(stageRoot, "verify-live-localized.datc64");
      const liveVerifyUniqueWords = path.join(stageRoot, "verify-live-localized-words.datc64");
      const liveVerifyAuxiliary = Object.fromEntries(AUXILIARY_RESOURCE_SPECS.map((spec) => [
        spec.id,
        path.join(stageRoot, `verify-live-${spec.id}.datc64`),
      ])) as Record<AuxiliaryResourceId, string>;
      await this.tool.extract(
        livePath(clientRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        bundleRoot(clientRoot),
        LOCALIZED_RESOURCE,
        liveVerifyBaseItems,
      );
      await this.tool.extract(
        livePath(clientRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        bundleRoot(clientRoot),
        LOCALIZED_WORDS_RESOURCE,
        liveVerifyUniqueWords,
      );
      for (const spec of AUXILIARY_RESOURCE_SPECS) {
        await this.tool.extract(
          livePath(clientRoot, INDEX_RELATIVE),
          bundleRoot(clientRoot),
          bundleRoot(clientRoot),
          spec.localizedResource,
          liveVerifyAuxiliary[spec.id],
        );
      }
      if (
        (await sha256File(liveVerifyBaseItems)) !== patchedResourceSha256 ||
        (await sha256File(liveVerifyUniqueWords)) !== patchedUniqueWordsSha256 ||
        !(await Promise.all(AUXILIARY_RESOURCE_SPECS.map(async (spec) =>
          (await sha256File(liveVerifyAuxiliary[spec.id])) === patchedAuxiliaryHashes[spec.id],
        ))).every(Boolean)
      ) {
        throw new Error("客户端写入后标价资源回读校验失败");
      }
      this.log(
        `标价补丁已应用：${matchedCount} 个名称（基础物品 ${patchedBaseItems.matchedCount}，唯一物品 ${patchedUniqueWords.matchedCount}，扩展类别 ${auxiliaryMatchedCount}）`,
      );
      return {
        baselineId: prepared.manifest.id,
        appliedFiles,
        appliedCustomFiles: customRelative,
        patchedResourceSha256,
        patchedUniqueWordsSha256,
        patchedAuxiliarySha256,
        matchedCount,
        skipped: false,
      };
    } finally {
      await fs.promises.rm(stageRoot, { recursive: true, force: true });
    }
  }

  /**
   * 强制以「当前客户端」为基准重建只读基线备份（重置基线）。
   * 用于初始备份有问题、或想重新以现在状态为还原基准时。以当前磁盘上的标价资源原样
   * 快照为新基线，不做“去价格后缀”的清理。旧的基线目录保留，不会被覆盖删除。
   */
  async resetBaseline(clientRoot: string): Promise<{ baselineId: string; baselineDir: string }> {
    await this.assertClientSafe(clientRoot);
    const current = await this.currentResources(clientRoot);
    const created = await this.createBaseline(
      clientRoot,
      current,
      { applied: false } as unknown as PricePatchState,
      false,
    );
    return { baselineId: created.manifest.id, baselineDir: created.dir };
  }

  async restore(clientRoot: string, state: PricePatchState): Promise<RestorePatchResult> {
    const prepared = await this.prepareBaseline(clientRoot, state);
    const uniqueResources = uniqueWordBaseline(prepared.manifest);
    const auxiliaryResources = auxiliaryBaseline(prepared.manifest);
    const baselineAuxiliarySha256 = baselineAuxiliaryLocalizedDigest(auxiliaryResources);
    if (
      prepared.current.localizedSha256 === prepared.manifest.resources.localized.sha256 &&
      prepared.current.localizedWordsSha256 === uniqueResources.localizedWords.sha256 &&
      prepared.current.auxiliaryLocalizedSha256 === baselineAuxiliarySha256
    ) {
      return { baselineId: prepared.manifest.id, restored: false };
    }
    if (!state.applied && !prepared.changed) return { baselineId: prepared.manifest.id, restored: false };

    const stageRoot = this.tempDir("restore");
    try {
      const stagedRelatives = await this.copyCurrentSnapshot(prepared, clientRoot, stageRoot);
      const localizedInput = backupAbsolute(prepared.baselineDir, prepared.manifest.resources.localized);
      const localizedWordsInput = backupAbsolute(prepared.baselineDir, uniqueResources.localizedWords);
      const localizedAuxiliaryInputs = Object.fromEntries(AUXILIARY_RESOURCE_SPECS.map((spec) => [
        spec.id,
        backupAbsolute(prepared.baselineDir, auxiliaryResources[spec.id].localized),
      ])) as Record<AuxiliaryResourceId, string>;
      const stageBundles = bundleRoot(stageRoot);
      const customBundles = await this.tool.replace(
        livePath(stageRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        stageBundles,
        LOCALIZED_RESOURCE,
        localizedInput,
      );
      customBundles.push(
        ...(await this.tool.replace(
          livePath(stageRoot, INDEX_RELATIVE),
          bundleRoot(clientRoot),
          stageBundles,
          LOCALIZED_WORDS_RESOURCE,
          localizedWordsInput,
        )),
      );
      for (const spec of AUXILIARY_RESOURCE_SPECS) {
        customBundles.push(
          ...(await this.tool.replace(
            livePath(stageRoot, INDEX_RELATIVE),
            bundleRoot(clientRoot),
            stageBundles,
            spec.localizedResource,
            localizedAuxiliaryInputs[spec.id],
          )),
        );
      }
      const verifyStagedBaseItems = path.join(stageRoot, "verify-staged-localized.datc64");
      const verifyStagedUniqueWords = path.join(stageRoot, "verify-staged-localized-words.datc64");
      const verifyStagedAuxiliary = Object.fromEntries(AUXILIARY_RESOURCE_SPECS.map((spec) => [
        spec.id,
        path.join(stageRoot, `verify-staged-${spec.id}.datc64`),
      ])) as Record<AuxiliaryResourceId, string>;
      await this.tool.extract(
        livePath(stageRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        stageBundles,
        LOCALIZED_RESOURCE,
        verifyStagedBaseItems,
      );
      await this.tool.extract(
        livePath(stageRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        stageBundles,
        LOCALIZED_WORDS_RESOURCE,
        verifyStagedUniqueWords,
      );
      for (const spec of AUXILIARY_RESOURCE_SPECS) {
        await this.tool.extract(
          livePath(stageRoot, INDEX_RELATIVE),
          bundleRoot(clientRoot),
          stageBundles,
          spec.localizedResource,
          verifyStagedAuxiliary[spec.id],
        );
      }
      if (
        (await sha256File(verifyStagedBaseItems)) !== prepared.manifest.resources.localized.sha256 ||
        (await sha256File(verifyStagedUniqueWords)) !== uniqueResources.localizedWords.sha256 ||
        !(await Promise.all(AUXILIARY_RESOURCE_SPECS.map(async (spec) =>
          (await sha256File(verifyStagedAuxiliary[spec.id])) === auxiliaryResources[spec.id].localized.sha256,
        ))).every(Boolean)
      ) {
        throw new Error("恢复暂存区标价资源未通过基线校验");
      }

      const customRelative = [...new Set(customBundles)].map((item) => `Bundles2/${slash(item)}`);
      const candidates = [...new Set([
        ...stagedRelatives.filter((item) => item !== INDEX_RELATIVE),
        ...customRelative,
      ])];
      const replacements: ReplacementFile[] = [];
      for (const relativePath of candidates) {
        const changed = await this.changedReplacement(clientRoot, stageRoot, relativePath);
        if (changed) replacements.push(changed);
      }
      const indexReplacement = await this.changedReplacement(clientRoot, stageRoot, INDEX_RELATIVE);
      if (indexReplacement) replacements.push(indexReplacement);
      if (!replacements.length) throw new Error("恢复资源已变化，但未找到需要提交的 Bundle 文件");
      await this.writeOperationMarker({
        kind: "restore",
        clientRoot,
        baselineId: prepared.manifest.id,
        patchedResourceSha256: prepared.manifest.resources.localized.sha256,
        patchedUniqueWordsSha256: uniqueResources.localizedWords.sha256,
        patchedAuxiliarySha256: baselineAuxiliarySha256,
      });
      await this.commitSafe(clientRoot, replacements.map((item) => item.relativePath));
      await this.assertVersionUnchanged(clientRoot, prepared.current.signature);
      await replaceFilesTransaction(clientRoot, replacements);

      const localized = path.join(stageRoot, "verify-live-localized.datc64");
      const localizedWords = path.join(stageRoot, "verify-live-localized-words.datc64");
      const localizedAuxiliary = Object.fromEntries(AUXILIARY_RESOURCE_SPECS.map((spec) => [
        spec.id,
        path.join(stageRoot, `verify-live-${spec.id}.datc64`),
      ])) as Record<AuxiliaryResourceId, string>;
      await this.tool.extract(
        livePath(clientRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        bundleRoot(clientRoot),
        LOCALIZED_RESOURCE,
        localized,
      );
      await this.tool.extract(
        livePath(clientRoot, INDEX_RELATIVE),
        bundleRoot(clientRoot),
        bundleRoot(clientRoot),
        LOCALIZED_WORDS_RESOURCE,
        localizedWords,
      );
      for (const spec of AUXILIARY_RESOURCE_SPECS) {
        await this.tool.extract(
          livePath(clientRoot, INDEX_RELATIVE),
          bundleRoot(clientRoot),
          bundleRoot(clientRoot),
          spec.localizedResource,
          localizedAuxiliary[spec.id],
        );
      }
      if (
        (await sha256File(localized)) !== prepared.manifest.resources.localized.sha256 ||
        (await sha256File(localizedWords)) !== uniqueResources.localizedWords.sha256 ||
        !(await Promise.all(AUXILIARY_RESOURCE_SPECS.map(async (spec) =>
          (await sha256File(localizedAuxiliary[spec.id])) === auxiliaryResources[spec.id].localized.sha256,
        ))).every(Boolean)
      ) {
        throw new Error("恢复后标价资源未通过基线校验");
      }
    } finally {
      await fs.promises.rm(stageRoot, { recursive: true, force: true });
    }
    this.log("标价补丁已取消，所有标价名称资源已恢复且其他客户端修改保持不变");
    return { baselineId: prepared.manifest.id, restored: true };
  }
}
