import fs from "fs";
import https from "https";
import path from "path";
import { CURRENCIES, CurrencyDefinition } from "./currencies";

const CDN = "https://web.poecdn.com";
const STATIC = "https://www.pathofexile.com/api/trade/data/static";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface CurrencyIconFailure {
  label: string;
  file: string;
  reason: string;
}

export interface CurrencyIconSyncResult {
  downloaded: string[];
  skipped: string[];
  failed: CurrencyIconFailure[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPng(buf: Buffer): boolean {
  return buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function get(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : `${CDN}${res.headers.location}`;
        get(next).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败 ${res.statusCode}: ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error(`下载超时: ${url}`));
    });
  });
}

async function getRetry(url: string, attempts = 3): Promise<Buffer> {
  let last: Error | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      return await get(url);
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
      if (i + 1 < attempts) await sleep(500 * (i + 1));
    }
  }
  throw last;
}

async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emptyResult(skipped: CurrencyDefinition[]): CurrencyIconSyncResult {
  return { downloaded: [], skipped: skipped.map((c) => c.label), failed: [] };
}

export async function ensureCurrencyIcons(
  templatesDir: string,
  log?: (m: string) => void,
  timeoutMs = 90000,
): Promise<CurrencyIconSyncResult> {
  fs.mkdirSync(templatesDir, { recursive: true });
  const skipped = CURRENCIES.filter((c) => fs.existsSync(path.join(templatesDir, `${c.templateName}.png`)));
  const missing = CURRENCIES.filter((c) => !fs.existsSync(path.join(templatesDir, `${c.templateName}.png`)));
  if (!missing.length) return emptyResult(skipped);
  try {
    return await withTimeout(downloadMissing(templatesDir, missing, skipped, log), timeoutMs, "通货图标下载");
  } catch (e) {
    log?.(`内置通货图标下载失败（可稍后手动放入 templates）: ${e}`);
    return {
      ...emptyResult(skipped),
      failed: missing.map((c) => ({
        label: c.label,
        file: `${c.templateName}.png`,
        reason: String(e),
      })),
    };
  }
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

async function downloadMissing(
  templatesDir: string,
  missing: CurrencyDefinition[],
  skipped: CurrencyDefinition[],
  log?: (m: string) => void,
): Promise<CurrencyIconSyncResult> {
  const raw = JSON.parse((await getRetry(STATIC)).toString("utf8")) as {
    result?: { id?: string; entries?: { id: string; image?: string }[] }[];
  };
  const currencyGroup = (raw.result || []).find((g) => g.id === "Currency");
  const byId = Object.fromEntries((currencyGroup?.entries || []).map((e) => [e.id, e.image || ""]));
  const downloaded: string[] = [];
  const failed: CurrencyIconFailure[] = [];

  await mapPool(missing, 4, async (cur) => {
    const file = `${cur.templateName}.png`;
    const dest = path.join(templatesDir, file);
    const image = byId[cur.tradeId];
    if (!image) {
      failed.push({ label: cur.label, file, reason: "官方 Currency 组无此 tradeId" });
      return;
    }
    try {
      const url = image.startsWith("http") ? image : `${CDN}${image}`;
      const buf = await getRetry(url);
      if (!isPng(buf)) {
        failed.push({ label: cur.label, file, reason: "返回内容不是 PNG" });
        return;
      }
      fs.writeFileSync(dest, buf);
      downloaded.push(cur.label);
      log?.(`已写入内置通货图标: ${cur.label} → ${file}`);
    } catch (e) {
      failed.push({ label: cur.label, file, reason: String(e) });
    }
  });

  for (const f of failed) log?.(`通货图标下载失败: ${f.label}（${f.file}）: ${f.reason}`);
  return { downloaded, skipped: skipped.map((c) => c.label), failed };
}
