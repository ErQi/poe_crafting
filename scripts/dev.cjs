const { spawn, spawnSync, execSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const web = path.join(root, "web");
const DEV_URL = "http://127.0.0.1:5173";

let electron = null;

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidFile() {
  return path.join(root, ".electron-data", "main.pid");
}

function readPidFile() {
  try {
    return Number(fs.readFileSync(pidFile(), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

function listAppMainElectrons() {
  if (process.platform !== "win32") {
    return electron && electron.exitCode == null && electron.pid ? [electron.pid] : [];
  }
  const marker = path.normalize(electronExe()).toLowerCase().replace(/'/g, "''");
  const ps =
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${marker}') -and $_.CommandLine -notmatch '--type=' } | ` +
    `ForEach-Object { $_.ProcessId }`;
  try {
    const out = execSync(`powershell -NoProfile -NonInteractive -Command ${JSON.stringify(ps)}`, {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    return String(out)
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

function appElectronPids() {
  // Windows 回收 PID 很快，上次崩溃留下的 pid 文件可能指向别的进程。
  // listAppMainElectrons 校验了进程名与命令行，只有它确认过的 pid 才允许强杀。
  const verified = listAppMainElectrons();
  const pids = new Set(verified);
  const filePid = readPidFile();
  if (filePid && (process.platform === "win32" ? verified.includes(filePid) : pidAlive(filePid))) {
    pids.add(filePid);
  }
  if (electron && electron.pid && electron.exitCode == null) pids.add(electron.pid);
  return [...pids];
}

function killPid(pid, sync = false) {
  if (!pid) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/t", "/f"];
    const opts = { stdio: "ignore", windowsHide: true };
    if (sync) spawnSync("taskkill", args, { ...opts, timeout: 5000 });
    else spawn("taskkill", args, opts);
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

function killAppElectrons() {
  for (const pid of appElectronPids()) killPid(pid);
}

function killTree(child) {
  if (child && !child.killed && child.exitCode == null && child.pid) killPid(child.pid);
  killAppElectrons();
}

async function waitPidsGone(pids, timeoutMs = 0) {
  const start = Date.now();
  const list = [...new Set(pids.filter(Boolean))];
  while (list.some((pid) => pidAlive(pid))) {
    if (timeoutMs && Date.now() - start > timeoutMs) return;
    await sleep(300);
  }
}

function buildElectron() {
  execSync("node scripts/build-electron.cjs --sourcemap", { cwd: root, stdio: "inherit" });
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

  let generation = 0;
  let stopping = false;

  // 关终端 / Ctrl+C 都要等 taskkill 真正做完，否则 electron.exe 变孤儿
  async function stopAsync(code = 0) {
    if (stopping) return;
    stopping = true;
    generation += 1;
    const pids = appElectronPids();
    killTree(electron);
    killTree(vite);
    await waitPidsGone(pids, 3000);
    process.exit(code ?? 0);
  }

  const stop = (code = 0) => void stopAsync(code);

  function startElectron() {
    const gen = generation;
    // 不用 shell:true：Windows 上 cmd 会因 GUI 子系统立刻退出，electron.exe 变成孤儿，父进程误 process.exit
    electron = spawn(electronExe(), [".", "--dev"], {
      stdio: "inherit",
      windowsHide: false,
      cwd: root,
      env,
      shell: false,
    });
    const spawnPid = electron.pid;
    electron.on("error", (err) => {
      console.error(err);
      process.exit(1);
    });
    electron.on("exit", (code) => {
      if (gen !== generation) return;
      electron = null;
      void waitForRealElectron(gen, spawnPid, code ?? 0);
    });
  }

  async function waitForRealElectron(gen, spawnPid, code) {
    let live = [];
    const deadline = Date.now() + 800;
    do {
      if (gen !== generation) return;
      live = appElectronPids().filter((pid) => pid !== spawnPid && pidAlive(pid));
      if (live.length) break;
      await sleep(150);
    } while (Date.now() < deadline);
    if (gen !== generation) return;
    if (live.length) {
      console.log("[dev] spawn 已退出，继续等待 electron.exe", live.join(", "));
      while (gen === generation && appElectronPids().some((pid) => pidAlive(pid))) {
        await sleep(500);
      }
    }
    if (gen !== generation) return;
    stop(code);
  }

  console.log(`[dev] 加载 ${DEV_URL}（仅 Vue 热更新；Electron 源码变更需手动重启开发进程）`);
  killAppElectrons();
  await waitPidsGone(appElectronPids(), 4000);
  startElectron();

  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
    process.on(signal, () => stop(0));
  }
  process.on("exit", () => {
    if (stopping) return;
    killPid(electron && electron.pid, true);
    killPid(vite && vite.pid, true);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
