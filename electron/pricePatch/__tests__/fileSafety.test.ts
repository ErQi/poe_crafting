import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { recoverInterruptedTransactions, replaceFilesTransaction, sha256File } from "../fileSafety";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "poe-price-patch-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe("客户端文件事务", () => {
  it("替换与移除完成后返回可审计 SHA-256", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source.bin");
    const target = path.join(root, "Bundles2", "_.index.bin");
    const stale = path.join(root, "Bundles2", "LibGGPK3", "1.bundle.bin");
    await fs.promises.mkdir(path.dirname(stale), { recursive: true });
    await fs.promises.writeFile(source, "new-index");
    await fs.promises.writeFile(target, "old-index");
    await fs.promises.writeFile(stale, "stale");

    const result = await replaceFilesTransaction(
      root,
      [{ relativePath: "Bundles2/_.index.bin", sourcePath: source }],
      ["Bundles2/LibGGPK3/1.bundle.bin"],
    );
    expect(await fs.promises.readFile(target, "utf8")).toBe("new-index");
    expect(fs.existsSync(stale)).toBe(false);
    expect(result[0].sha256).toBe(await sha256File(source));
  });

  it("发现中断事务时先恢复旧文件并校验", async () => {
    const root = await tempRoot();
    const target = path.join(root, "Bundles2", "_.index.bin");
    const txn = path.join(root, ".poecrafting-txn-crash");
    const backup = path.join(txn, "rollback", "Bundles2", "_.index.bin");
    await fs.promises.mkdir(path.dirname(backup), { recursive: true });
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, "half-written-new");
    await fs.promises.writeFile(backup, "known-old");
    const beforeSha256 = await sha256File(backup);
    await fs.promises.writeFile(
      path.join(txn, "journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        root,
        operations: [
          { kind: "replace", relativePath: "Bundles2/_.index.bin", existed: true, beforeSha256 },
        ],
      }),
    );

    await recoverInterruptedTransactions(root);
    expect(await fs.promises.readFile(target, "utf8")).toBe("known-old");
    expect(fs.existsSync(txn)).toBe(false);
  });

  it("中途无法换入后续文件时，已换入的文件会恢复到原 SHA-256", async () => {
    const root = await tempRoot();
    const firstSource = path.join(root, "first-source.bin");
    const secondSource = path.join(root, "second-source.bin");
    const firstTarget = path.join(root, "Bundles2", "LibGGPK3", "0.bundle.bin");
    await fs.promises.mkdir(path.dirname(firstTarget), { recursive: true });
    await fs.promises.writeFile(firstTarget, "original-bundle");
    await fs.promises.writeFile(firstSource, "new-bundle");
    await fs.promises.writeFile(secondSource, "new-index");
    // 父路径故意是文件，使第二个目标只能在提交阶段失败；第一个目标此时已经换入。
    await fs.promises.writeFile(path.join(root, "blocked"), "not-a-directory");

    await expect(
      replaceFilesTransaction(root, [
        { relativePath: "Bundles2/LibGGPK3/0.bundle.bin", sourcePath: firstSource },
        { relativePath: "blocked/_.index.bin", sourcePath: secondSource },
      ]),
    ).rejects.toThrow();
    expect(await fs.promises.readFile(firstTarget, "utf8")).toBe("original-bundle");
  });
});
