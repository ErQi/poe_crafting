const { spawn, execSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const web = path.join(root, "web");
const electronDir = path.join(root, "electron");
const DEV_URL = "http://127.0.0.1:5173";

function httpStatus(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on("error", () => resolve(0));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(0);
    });
  });
}

async function waitVite(ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if ((await httpStatus(`${DEV_URL}/@vite/client`)) === 200) return;
    if (Date.now() > deadline) throw new Error(`${DEV_URL} 未就绪（需要 Vite 开发服务）`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function electronExe() {
  let exe = "";
  try {
    exe = require("electron");
  } catch {
    /* empty */
  }
  if (!exe || !fs.existsSync(exe)) {
    console.error("未找到 electron，请先运行: npm install");
    process.exit(1);
  }
  return exe;
}

function killTree(child) {
  if (!child || child.killed || child.exitCode != null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

function buildElectron() {
  execSync("node scripts/build-electron.cjs", { cwd: root, stdio: "inherit" });
}

function isElectronSource(filename) {
  if (!filename) return false;
  const n = String(filename).replace(/\\/g, "/");
  if (n === "dist" || n.startsWith("dist/")) return false;
  return /\.(ts|js|html|css|json)$/.test(n);
}

async function main() {
  buildElectron();

  let vite = null;
  if ((await httpStatus(`${DEV_URL}/@vite/client`)) !== 200) {
    if (await httpStatus(DEV_URL)) {
      throw new Error(`${DEV_URL} 已被占用且不是 Vite 开发服务，请关闭后重试`);
    }
    vite = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], {
      stdio: "inherit",
      windowsHide: false,
      shell: true,
      cwd: web,
    });
    vite.on("error", (err) => {
      console.error(err);
      process.exit(1);
    });
    await waitVite();
  }

  const env = {
    ...process.env,
    ELECTRON_DEV: "1",
    POE_DEV: "1",
    ELECTRON_START_URL: DEV_URL,
  };

  let electron = null;
  let generation = 0;
  let restarting = false;

  const stop = (code = 0) => {
    killTree(vite);
    process.exit(code ?? 0);
  };

  function startElectron() {
    const gen = generation;
    electron = spawn(electronExe(), [".", "--dev"], {
      stdio: "inherit",
      windowsHide: false,
      cwd: root,
      env,
    });
    electron.on("error", (err) => {
      console.error(err);
      process.exit(1);
    });
    electron.on("exit", (code) => {
      if (gen !== generation) return;
      electron = null;
      stop(code ?? 0);
    });
  }

  function waitExit(child) {
    if (!child || child.exitCode != null) return Promise.resolve();
    return new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 4000);
    });
  }

  async function restartElectron() {
    if (restarting) return;
    restarting = true;
    generation += 1;
    const prev = electron;
    try {
      console.log("[dev] 检测到 electron/ 变动，重建并重启");
      buildElectron();
      killTree(prev);
      await waitExit(prev);
      startElectron();
    } catch (err) {
      console.error("[dev] 重启失败:", err);
    } finally {
      restarting = false;
    }
  }

  console.log(`[dev] 加载 ${DEV_URL}（Vue 热更新；改 electron/ 会重启进程）`);
  startElectron();

  let debounce;
  try {
    fs.watch(electronDir, { recursive: true }, (_evt, filename) => {
      if (!isElectronSource(filename)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void restartElectron(), 300);
    });
  } catch (err) {
    console.error("[dev] 无法监视 electron/:", err);
  }

  process.on("SIGINT", () => {
    generation += 1;
    killTree(electron);
    stop(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
