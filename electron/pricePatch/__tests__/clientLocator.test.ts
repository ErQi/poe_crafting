import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizePoeClientRoot } from "../clientLocator";

const roots: string[] = [];

async function makeClient(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "poe-client-root-"));
  roots.push(root);
  await fs.promises.mkdir(path.join(root, "Bundles2"), { recursive: true });
  await fs.promises.writeFile(path.join(root, "PathOfExile_x64.exe"), "");
  await fs.promises.writeFile(path.join(root, "Bundles2", "_.index.bin"), "");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe("国服客户端自定义路径", () => {
  it("接受带引号的完整客户端目录并规范化", async () => {
    const root = await makeClient();
    expect(normalizePoeClientRoot(`  "${root}"  `)).toBe(fs.realpathSync.native(root));
  });

  it("明确列出无效目录缺少的客户端文件", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "poe-client-root-"));
    roots.push(root);
    expect(() => normalizePoeClientRoot(root)).toThrow(/PathOfExile_x64\.exe/);
    expect(() => normalizePoeClientRoot(root)).toThrow(/Bundles2/);
  });
});
