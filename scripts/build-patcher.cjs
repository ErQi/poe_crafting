const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const cacheRoot = path.join(root, "tools", ".cache", "libggpk3-v2.7.5");
const zipFile = path.join(cacheRoot, "win-x64.zip");
const vendorRoot = path.join(cacheRoot, "vendor");
const vendorDir = path.join(vendorRoot, "win-x64");
const licenseFile = path.join(cacheRoot, "LICENSE.LibGGPK3.txt");
const output = path.join(root, "assets", "patcher", "win-x64");
const project = path.join(root, "tools", "PoeBundleTool", "PoeBundleTool.csproj");
const notice = path.join(root, "tools", "PoeBundleTool", "THIRD_PARTY_NOTICES.md");
const url = "https://github.com/aianlinb/LibGGPK3/releases/download/v2.7.5/win-x64.zip";
const licenseUrl = "https://raw.githubusercontent.com/aianlinb/LibGGPK3/v2.7.5/LICENSE";
const expectedSha256 = "08c3b4c9af9cc9540179257b8ba93a7469816b20d4ffec5b45a7d04ee0927e2b";
const expectedLicenseSha256 = "8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef";

function inside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function download(target, source, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error("下载补丁组件时重定向过多"));
  return new Promise((resolve, reject) => {
    https.get(source, { headers: { "User-Agent": "POE-Tools-build" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(target, new URL(response.headers.location, source).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`下载 LibGGPK3 失败（HTTP ${response.statusCode}）`));
        return;
      }
      const temp = `${target}.part`;
      const file = fs.createWriteStream(temp, { flags: "w" });
      response.pipe(file);
      file.once("error", reject);
      file.once("finish", () => {
        file.close(() => {
          fs.renameSync(temp, target);
          resolve();
        });
      });
    }).once("error", reject);
  });
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} 执行失败（${result.status ?? "no exit code"}）`);
}

async function main() {
  if (!inside(path.join(root, "tools"), cacheRoot) || !inside(path.join(root, "assets"), output)) {
    throw new Error("补丁组件输出路径越界");
  }
  fs.mkdirSync(cacheRoot, { recursive: true });
  if (!fs.existsSync(zipFile) || hash(zipFile) !== expectedSha256) {
    if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
    await download(zipFile, url);
  }
  if (hash(zipFile) !== expectedSha256) throw new Error("LibGGPK3 下载文件 SHA-256 校验失败");
  if (!fs.existsSync(licenseFile) || hash(licenseFile) !== expectedLicenseSha256) {
    if (fs.existsSync(licenseFile)) fs.unlinkSync(licenseFile);
    await download(licenseFile, licenseUrl);
  }
  if (hash(licenseFile) !== expectedLicenseSha256) throw new Error("LibGGPK3 许可证文件校验失败");
  if (!fs.existsSync(path.join(vendorDir, "LibBundle3.dll"))) {
    if (fs.existsSync(vendorRoot)) fs.rmSync(vendorRoot, { recursive: true, force: true });
    fs.mkdirSync(vendorRoot, { recursive: true });
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $env:POE_PATCH_ZIP -DestinationPath $env:POE_PATCH_VENDOR -Force",
    ], { ...process.env, POE_PATCH_ZIP: zipFile, POE_PATCH_VENDOR: vendorRoot });
  }
  fs.mkdirSync(output, { recursive: true });
  run("dotnet", [
    "publish",
    project,
    "-c", "Release",
    "-r", "win-x64",
    "--self-contained", "true",
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:EnableCompressionInSingleFile=true",
    `-p:LibGGPK3Dir=${vendorDir}`,
    "-o", output,
  ]);
  for (const generated of ["LibBundle3.pdb", "LibBundle3.xml", "PoeBundleTool.pdb"]) {
    const file = path.join(output, generated);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.copyFileSync(notice, path.join(output, "THIRD_PARTY_NOTICES.md"));
  fs.copyFileSync(licenseFile, path.join(output, "LICENSE.LibGGPK3.txt"));
  const exe = path.join(output, "PoeBundleTool.exe");
  if (!fs.existsSync(exe)) throw new Error("PoeBundleTool.exe 未生成");
  console.log(`PoeBundleTool ready: ${exe} (${fs.statSync(exe).size} bytes)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
