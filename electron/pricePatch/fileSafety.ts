import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type { AppliedFileFingerprint } from "./types";

const TRANSACTION_PREFIX = ".poecrafting-txn-";

export interface ReplacementFile {
  relativePath: string;
  sourcePath: string;
}

interface JournalOperation {
  kind: "replace" | "remove";
  relativePath: string;
  existed: boolean;
  beforeSha256: string;
}

interface TransactionJournal {
  schemaVersion: 1;
  root: string;
  operations: JournalOperation[];
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export function resolveInside(root: string, relativePath: string): string {
  if (!path.isAbsolute(root)) throw new Error("事务根目录必须是绝对路径");
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`非法相对路径: ${relativePath}`);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (!inside(resolvedRoot, target) || target === resolvedRoot) throw new Error(`路径超出事务目录: ${relativePath}`);
  return target;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export async function fingerprintFile(file: string, relativePath = path.basename(file)): Promise<AppliedFileFingerprint> {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new Error(`不是文件: ${file}`);
  return { relativePath, size: stat.size, sha256: await sha256File(file) };
}

interface LightFingerprint {
  size: number;
  mtimeMs: number;
}

async function lightFingerprint(file: string): Promise<LightFingerprint> {
  const stat = await fs.promises.stat(file);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function assertFilesStable(files: string[], waitMs = 1500): Promise<void> {
  const unique = [...new Set(files.map((file) => path.resolve(file)))];
  const before = await Promise.all(unique.map(lightFingerprint));
  await pause(waitMs);
  const after = await Promise.all(unique.map(lightFingerprint));
  for (let index = 0; index < unique.length; index += 1) {
    if (before[index].size !== after[index].size || before[index].mtimeMs !== after[index].mtimeMs) {
      throw new Error(`客户端文件仍在变化: ${path.basename(unique[index])}`);
    }
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.promises.rename(tmp, file);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

async function moveIfExists(source: string, destination: string): Promise<boolean> {
  if (!(await exists(source))) return false;
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.rename(source, destination);
  return true;
}

async function verifyJournalRestored(root: string, journal: TransactionJournal): Promise<void> {
  for (const operation of journal.operations) {
    const target = resolveInside(root, operation.relativePath);
    if (!operation.existed) {
      if (await exists(target)) throw new Error(`回滚后仍有新增文件: ${operation.relativePath}`);
      continue;
    }
    if (!(await exists(target))) throw new Error(`回滚后缺少文件: ${operation.relativePath}`);
    if ((await sha256File(target)) !== operation.beforeSha256) {
      throw new Error(`回滚校验失败: ${operation.relativePath}`);
    }
  }
}

async function rollbackTransaction(root: string, txnDir: string, journal: TransactionJournal): Promise<void> {
  const rollbackRoot = path.join(txnDir, "rollback");
  const failedRoot = path.join(txnDir, "failed-new");
  for (const operation of [...journal.operations].reverse()) {
    const target = resolveInside(root, operation.relativePath);
    const backup = resolveInside(rollbackRoot, operation.relativePath);
    if (await exists(backup)) {
      if (await exists(target)) await moveIfExists(target, resolveInside(failedRoot, operation.relativePath));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.rename(backup, target);
    } else if (!operation.existed && (await exists(target))) {
      await moveIfExists(target, resolveInside(failedRoot, operation.relativePath));
    }
  }
  await verifyJournalRestored(root, journal);
}

/**
 * 上次进程若在多文件切换中崩溃，先按同盘事务目录里的原文件回滚。
 * 这里只扫描 POE Tools 自己的固定前缀，绝不触碰其他目录。
 */
export async function recoverInterruptedTransactions(root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(resolvedRoot);
  } catch {
    return;
  }
  for (const name of names.filter((item) => item.startsWith(TRANSACTION_PREFIX))) {
    const txnDir = resolveInside(resolvedRoot, name);
    const journalFile = path.join(txnDir, "journal.json");
    if (!(await exists(journalFile))) {
      // 清单写入发生在任何 live rename 之前；没有清单的目录只含未生效暂存副本。
      await fs.promises.rm(txnDir, { recursive: true, force: true });
      continue;
    }
    const parsed = JSON.parse(await fs.promises.readFile(journalFile, "utf8")) as TransactionJournal;
    if (parsed.schemaVersion !== 1 || path.resolve(parsed.root) !== resolvedRoot || !Array.isArray(parsed.operations)) {
      throw new Error(`发现无法识别的补丁恢复记录: ${name}`);
    }
    await rollbackTransaction(resolvedRoot, txnDir, parsed);
    await fs.promises.rm(txnDir, { recursive: true, force: true });
  }
}

/**
 * 同一磁盘内先备份旧文件再逐个换入，索引由调用方放在 replacements 最后。
 * 任一步失败都会按 SHA-256 校验回滚；移除项也只是先移动到事务目录。
 */
export async function replaceFilesTransaction(
  root: string,
  replacements: ReplacementFile[],
  removals: string[] = [],
): Promise<AppliedFileFingerprint[]> {
  const resolvedRoot = path.resolve(root);
  await recoverInterruptedTransactions(resolvedRoot);
  const txnDir = resolveInside(resolvedRoot, `${TRANSACTION_PREFIX}${randomUUID()}`);
  const stagedRoot = path.join(txnDir, "staged");
  const rollbackRoot = path.join(txnDir, "rollback");
  await fs.promises.mkdir(stagedRoot, { recursive: true });

  const replacementPaths = new Set<string>();
  const stagedFingerprints = new Map<string, AppliedFileFingerprint>();
  for (const replacement of replacements) {
    if (replacementPaths.has(replacement.relativePath)) throw new Error(`重复替换目标: ${replacement.relativePath}`);
    replacementPaths.add(replacement.relativePath);
    const staged = resolveInside(stagedRoot, replacement.relativePath);
    await fs.promises.mkdir(path.dirname(staged), { recursive: true });
    await fs.promises.copyFile(replacement.sourcePath, staged, fs.constants.COPYFILE_EXCL);
    const sourceHash = await sha256File(replacement.sourcePath);
    const stagedFingerprint = await fingerprintFile(staged, replacement.relativePath);
    if (sourceHash !== stagedFingerprint.sha256) throw new Error(`事务暂存校验失败: ${replacement.relativePath}`);
    stagedFingerprints.set(replacement.relativePath, stagedFingerprint);
  }

  const removePaths = [...new Set(removals)].filter((item) => !replacementPaths.has(item));
  const operations: JournalOperation[] = [];
  for (const relativePath of [...replacementPaths, ...removePaths]) {
    const target = resolveInside(resolvedRoot, relativePath);
    const present = await exists(target);
    operations.push({
      kind: replacementPaths.has(relativePath) ? "replace" : "remove",
      relativePath,
      existed: present,
      beforeSha256: present ? await sha256File(target) : "",
    });
  }
  const journal: TransactionJournal = { schemaVersion: 1, root: resolvedRoot, operations };
  await writeJson(path.join(txnDir, "journal.json"), journal);

  try {
    for (const operation of operations) {
      const target = resolveInside(resolvedRoot, operation.relativePath);
      const backup = resolveInside(rollbackRoot, operation.relativePath);
      if (operation.existed) await moveIfExists(target, backup);
      if (operation.kind === "replace") {
        const staged = resolveInside(stagedRoot, operation.relativePath);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.rename(staged, target);
      }
    }
    const result: AppliedFileFingerprint[] = [];
    for (const replacement of replacements) {
      const target = resolveInside(resolvedRoot, replacement.relativePath);
      const actual = await fingerprintFile(target, replacement.relativePath);
      const expected = stagedFingerprints.get(replacement.relativePath);
      if (!expected || expected.sha256 !== actual.sha256 || expected.size !== actual.size) {
        throw new Error(`写入后校验失败: ${replacement.relativePath}`);
      }
      result.push(actual);
    }
    for (const relativePath of removePaths) {
      if (await exists(resolveInside(resolvedRoot, relativePath))) throw new Error(`未能移除旧补丁文件: ${relativePath}`);
    }
    await fs.promises.rm(txnDir, { recursive: true, force: true });
    return result;
  } catch (error) {
    try {
      await rollbackTransaction(resolvedRoot, txnDir, journal);
      await fs.promises.rm(txnDir, { recursive: true, force: true });
    } catch (rollbackError) {
      throw new Error(`文件切换失败，自动回滚也未通过校验: ${String(rollbackError)}`);
    }
    throw error;
  }
}
