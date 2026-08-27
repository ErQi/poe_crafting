import { createHash } from "crypto";
import { gunzipSync } from "zlib";
import type { PriceQuote, PriceSnapshot } from "./types";

export const EFARM_PRICE_URLS = [
  ...Array.from({ length: 9 }, (_, index) => `https://cf.981001.xyz/${index + 1}/fkhprice2.txt`),
  "https://www.710421059.xyz/file/fkhprice2.txt",
  "https://efarm-zero.981001.xyz/file/fkhprice2.txt",
] as readonly string[];
export const POE_CURRENCY_SUMMARY_URL = "https://poecurrency.top/api/summary?version=1";
export const POE_NINJA_LEAGUES_URL = "https://poe.ninja/poe1/api/economy/leagues";
export const POE_NINJA_EXCHANGE_TYPES = [
  "Currency",
  "Fragment",
  "Runegraft",
  "AllflameEmber",
  "Tattoo",
  "Omen",
  "DjinnCoin",
  "Ducat",
  "EnshroudingCrystal",
  "DivinationCard",
  "Artifact",
  "Oil",
  "DeliriumOrb",
  "Scarab",
  "Astrolabe",
  "Fossil",
  "Resonator",
  "Essence",
] as const;

// poe.ninja POE1 stash API 的非唯一物品类别。有等级、品质、词缀或地图阶级的
// 类别会折叠到客户端可稳定显示的名称，并以挂单量最高的行作为代表价。
export const POE_NINJA_STASH_ITEM_TYPES = [
  "Wombgift",
  "Corpse",
  "Incubator",
  "SkillGem",
  "ImbuedGem",
  "ClusterJewel",
  "Map",
  "BlightedMap",
  "BlightRavagedMap",
  "ValdoMap",
  "Invitation",
  "Memory",
  "IncursionTemple",
  "ScryingOrb",
  "BaseType",
  "Flask",
  "Beast",
  "Vial",
] as const;

// 唯一装备名不在 BaseItemTypes，而由 UniqueStashLayout 指向 Words；这些类别走单独的
// Words.Text2 标价链路。同名多变体沿用 poe.ninja 挂单量最高的代表行。
export const POE_NINJA_UNIQUE_ITEM_TYPES = [
  "UniqueWeapon",
  "UniqueArmour",
  "UniqueAccessory",
  "UniqueFlask",
  "UniqueJewel",
  "ForbiddenJewel",
  "ShrineBelt",
  "UniqueTincture",
  "UniqueRelic",
  "UniqueMap",
] as const;

export const POE_NINJA_ITEM_TYPES = [
  ...POE_NINJA_STASH_ITEM_TYPES,
  ...POE_NINJA_UNIQUE_ITEM_TYPES,
] as const;

const MAX_PRICE_AGE_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const NINJA_REQUEST_CONCURRENCY = 6;
const MAX_EFARM_ENCODED_BYTES = 4 * 1024 * 1024;
const MAX_EFARM_DECODED_BYTES = 64 * 1024 * 1024;
const USER_AGENT = "POE-Tools/0.4.7 price-patch";

interface FetchHeaders {
  get(name: string): string | null;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  headers?: FetchHeaders;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

interface NinjaCandidate {
  quote: PriceQuote;
  listingCount: number;
  observationCount: number;
  stableId: string;
}

interface NinjaJob {
  kind: "exchange" | "item";
  type: string;
  url: string;
}

interface NinjaJobResult {
  quotes: PriceQuote[];
  error: string;
}

interface EfarmCandidate {
  quote: PriceQuote;
  listingCount: number;
  stableId: string;
}

export type PriceFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<FetchResponse>;

function defaultFetch(url: string, init: { signal: AbortSignal; headers: Record<string, string> }): Promise<FetchResponse> {
  const fn = (globalThis as unknown as { fetch?: PriceFetch }).fetch;
  if (!fn) throw new Error("当前运行环境不支持网络请求");
  return fn(url, init);
}

function finitePositive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function finiteNonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 接口时间没有时区后缀，文档约定为东八区；显式补上，避免系统时区影响过期判断。 */
export function parseSourceTime(value: unknown): number | null {
  const raw = text(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`;
  const valueMs = Date.parse(iso);
  return Number.isFinite(valueMs) ? valueMs : null;
}

function sourceTimeMs(value: string): number {
  const chinaTime = parseSourceTime(value);
  if (chinaTime != null) return chinaTime;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseHttpTime(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatPrice(value: number, unit: "c" | "d" | "e"): string {
  const rounded = unit === "d" || value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  const safe = Math.max(0.1, rounded);
  return `${Number.isInteger(safe) ? safe.toFixed(0) : safe.toFixed(1)}${unit}`;
}

function efarmTargetName(raw: Record<string, unknown>): string {
  const name = text(raw.name);
  const baseType = text(raw.baseType);
  const frameType = Number(raw.frameType);
  // 唯一物品必须按唯一名标到 Words；星团珠宝的动态附魔名不会出现在静态资源中。
  if (frameType === 3) return name || baseType;
  if (baseType.includes("星团珠宝")) return baseType || name;
  return name || baseType;
}

function betterEfarmCandidate(next: EfarmCandidate, current: EfarmCandidate): boolean {
  if (next.listingCount !== current.listingCount) return next.listingCount > current.listingCount;
  return next.stableId.localeCompare(current.stableId, "en") < 0;
}

/** 解析易刷客户端公开使用的当季国服压缩价表；calculated 的单位固定为混沌石。 */
export function parseEfarmPriceFile(
  encodedPayload: string,
  sourceTime: string,
  nowMs = Date.now(),
): PriceSnapshot {
  const sourceMs = parseHttpTime(sourceTime);
  if (sourceMs == null || nowMs - sourceMs > MAX_PRICE_AGE_MS) throw new Error("易刷国服价表已过期");
  const encoded = encodedPayload.trim();
  if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_EFARM_ENCODED_BYTES) {
    throw new Error("易刷国服价表大小异常");
  }

  let payload: unknown;
  try {
    const compressed = Buffer.from(encoded, "base64");
    if (!compressed.length) throw new Error("empty gzip payload");
    const decoded = gunzipSync(compressed, { maxOutputLength: MAX_EFARM_DECODED_BYTES });
    payload = JSON.parse(decoded.toString("utf8"));
  } catch (error) {
    throw new Error(`易刷国服价表解压失败：${errorText(error)}`);
  }
  if (!Array.isArray(payload)) throw new Error("易刷国服价表格式不正确");

  const selected = new Map<string, EfarmCandidate>();
  for (const item of payload) {
    const raw = record(item);
    if (!raw) continue;
    const itemName = efarmTargetName(raw);
    const value = finitePositive(raw.calculated);
    if (!itemName || value == null) continue;
    const candidate: EfarmCandidate = {
      quote: {
        itemName,
        englishName: "",
        category: "易刷国服",
        value,
        unit: "c",
        display: formatPrice(value, "c"),
        sourceTime,
        source: "efarm",
      },
      listingCount: finiteNonNegative(raw.count),
      stableId: `${text(raw.id)}\0${text(raw.searchCode)}\0${text(raw.variant)}`,
    };
    const identity = normalizedName(itemName);
    const current = selected.get(identity);
    if (!current || betterEfarmCandidate(candidate, current)) selected.set(identity, candidate);
  }
  const quotes = [...selected.values()]
    .map((candidate) => candidate.quote)
    .sort((a, b) => a.itemName.localeCompare(b.itemName, "zh-CN"));
  if (!quotes.length) throw new Error("易刷国服价表没有可用价格");
  return snapshotFromQuotes(convertHighChaosPricesToDivine(quotes), nowMs);
}

function quoteFromChina(raw: Record<string, unknown>, category: string, nowMs: number): PriceQuote | null {
  if (raw.error === true) return null;
  const itemName = text(raw.item_name);
  const englishName = text(raw.engname);
  if (!itemName && !englishName) return null;
  const unitRaw = text(raw.currency_unit).toLowerCase();
  if (unitRaw !== "c" && unitRaw !== "d" && unitRaw !== "e") return null;
  const sourceTime = text(raw.latest_datetime);
  const sourceMs = parseSourceTime(sourceTime);
  if (sourceMs == null || nowMs - sourceMs > MAX_PRICE_AGE_MS) return null;

  // 国服标价直接取接口的“最新买1”；缺失时才交给 poe.ninja 兜底，不混入均价或卖价算法。
  const value = finitePositive(raw.latest_buy1);
  if (value == null) return null;
  return {
    itemName,
    englishName,
    category,
    value,
    unit: unitRaw,
    display: formatPrice(value, unitRaw),
    sourceTime,
    source: "poecurrency",
  };
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function isDivineOrb(quote: PriceQuote): boolean {
  return normalizedName(quote.englishName) === "divine orb" || normalizedName(quote.itemName) === "神圣石";
}

/** 同一行情源内，高于一枚神圣石的混沌石价格自动换算成 d。 */
export function convertHighChaosPricesToDivine(quotes: PriceQuote[]): PriceQuote[] {
  const divineChaos = quotes.find((quote) => quote.unit === "c" && isDivineOrb(quote))?.value;
  if (!divineChaos || !Number.isFinite(divineChaos) || divineChaos <= 0) return quotes;
  return quotes.map((quote) => {
    if (quote.unit !== "c" || quote.value <= divineChaos) return quote;
    const value = quote.value / divineChaos;
    return { ...quote, value, unit: "d", display: formatPrice(value, "d") };
  });
}

function quoteIdentityKeys(quote: PriceQuote): string[] {
  const keys: string[] = [];
  if (quote.englishName) keys.push(`en:${normalizedName(quote.englishName)}`);
  if (quote.itemName) keys.push(`zh:${normalizedName(quote.itemName)}`);
  return keys;
}

function canonicalDigest(quotes: PriceQuote[]): string {
  const rows = [...quotes]
    .sort((a, b) => `${a.englishName}\0${a.itemName}`.localeCompare(`${b.englishName}\0${b.itemName}`, "en"))
    .map((quote) => [quote.englishName, quote.itemName, quote.display, quote.sourceTime, quote.source]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function snapshotFromQuotes(quotes: PriceQuote[], nowMs: number): PriceSnapshot {
  const fallbackTime = new Date(nowMs).toISOString();
  const sourceUpdatedAt = quotes.reduce(
    (latest, quote) => (sourceTimeMs(quote.sourceTime) > sourceTimeMs(latest) ? quote.sourceTime : latest),
    "",
  ) || fallbackTime;
  return {
    fetchedAt: fallbackTime,
    sourceUpdatedAt,
    digest: canonicalDigest(quotes),
    quotes,
  };
}

export function parsePriceSummary(payload: unknown, nowMs = Date.now()): PriceSnapshot {
  if (!Array.isArray(payload)) throw new Error("行情接口返回格式不正确");
  const quotes: PriceQuote[] = [];
  for (const group of payload) {
    const groupRecord = record(group);
    if (!groupRecord) continue;
    const category = text(groupRecord.category_label);
    if (!Array.isArray(groupRecord.items)) continue;
    for (const item of groupRecord.items) {
      const itemRecord = record(item);
      if (!itemRecord) continue;
      const quote = quoteFromChina(itemRecord, category, nowMs);
      if (quote) quotes.push(quote);
    }
  }
  if (!quotes.length) throw new Error("行情接口没有可用的 POE1 国服价格");
  return snapshotFromQuotes(convertHighChaosPricesToDivine(quotes), nowMs);
}

export function parseNinjaLeague(payload: unknown): string {
  if (!Array.isArray(payload)) throw new Error("poe.ninja 联盟接口返回格式不正确");
  for (const item of payload) {
    const id = text(record(item)?.id);
    if (id) return id;
  }
  throw new Error("poe.ninja 没有可用的 POE1 当前赛季");
}

function ninjaQuote(
  englishName: string,
  category: string,
  chaosValue: number,
  sourceTime: string,
): PriceQuote {
  return {
    itemName: "",
    englishName,
    category,
    value: chaosValue,
    unit: "c",
    // poe.ninja 的 divineValue 使用国际服神圣石汇率，不能直接作为国服的 d 单位。
    // 保留接口的混沌石基准价，避免同一个数字在国服表示成数倍价值。
    display: formatPrice(chaosValue, "c"),
    sourceTime,
    source: "poe-ninja",
  };
}

export function parseNinjaExchangeOverview(payload: unknown, category: string, sourceTime: string): PriceQuote[] {
  const root = record(payload);
  if (!root || !Array.isArray(root.lines) || !Array.isArray(root.items)) {
    throw new Error(`poe.ninja ${category} 行情格式不正确`);
  }
  const core = record(root.core);
  if (root.lines.length && text(core?.primary).toLowerCase() !== "chaos") {
    throw new Error(`poe.ninja ${category} 行情不是以混沌石计价`);
  }
  const names = new Map<string, string>();
  for (const item of root.items) {
    const itemRecord = record(item);
    const id = text(itemRecord?.id);
    const name = text(itemRecord?.name);
    if (id && name) names.set(id, name);
  }

  const quotes: PriceQuote[] = [];
  for (const line of root.lines) {
    const lineRecord = record(line);
    const name = names.get(text(lineRecord?.id));
    const chaosValue = finitePositive(lineRecord?.primaryValue);
    if (!name || chaosValue == null) continue;
    quotes.push(
      ninjaQuote(
        name,
        `poe.ninja ${category}`,
        chaosValue,
        sourceTime,
      ),
    );
  }
  return quotes;
}

function betterCandidate(next: NinjaCandidate, current: NinjaCandidate): boolean {
  if (next.listingCount !== current.listingCount) return next.listingCount > current.listingCount;
  if (next.observationCount !== current.observationCount) return next.observationCount > current.observationCount;
  return next.stableId.localeCompare(current.stableId, "en") < 0;
}

/**
 * 把 poe.ninja 的可变行名折叠到客户端真正会显示的稳定名称。
 * 精确变体价依然由挂单量最高的行决定，避免随机名、阶级或词缀导致完全无法匹配。
 */
export function ninjaItemTargetName(category: string, line: Record<string, unknown>): string {
  const name = text(line.name);
  const baseType = text(line.baseType);
  switch (category) {
    case "ForbiddenJewel":
      return text(line.variant) || name;
    case "SkillGem":
      // 瓦尔+异化宝石的 API 名称会组合两个技能名，客户端没有该组合字符串。
      return /\s+\(.+\)$/u.test(name) ? baseType || name : name;
    case "ClusterJewel":
    case "Map":
    case "ValdoMap":
    case "ScryingOrb":
      return baseType || name;
    case "BlightedMap":
      return "Blighted Map";
    case "BlightRavagedMap":
      return "Blight-ravaged Map";
    case "IncursionTemple":
      return name.replace(/\s+\(Tier\s+\d+\)$/iu, "") || baseType;
    default:
      return name;
  }
}

export function parseNinjaItemOverview(payload: unknown, category: string, sourceTime: string): PriceQuote[] {
  const root = record(payload);
  if (!root || !Array.isArray(root.lines)) throw new Error(`poe.ninja ${category} 行情格式不正确`);
  const selected = new Map<string, NinjaCandidate>();
  for (const line of root.lines) {
    const lineRecord = record(line);
    if (!lineRecord) continue;
    const name = ninjaItemTargetName(category, lineRecord);
    const chaosValue = finitePositive(lineRecord?.chaosValue);
    if (!name || chaosValue == null) continue;
    const candidate: NinjaCandidate = {
      quote: ninjaQuote(name, `poe.ninja ${category}`, chaosValue, sourceTime),
      listingCount: finiteNonNegative(lineRecord?.listingCount),
      observationCount: finiteNonNegative(lineRecord?.count),
      stableId: text(lineRecord?.detailsId) || text(lineRecord?.id),
    };
    const key = normalizedName(name);
    const current = selected.get(key);
    if (!current || betterCandidate(candidate, current)) selected.set(key, candidate);
  }
  return [...selected.values()]
    .map((candidate) => candidate.quote)
    .sort((a, b) => a.englishName.localeCompare(b.englishName, "en"));
}

export function mergePriceSnapshots(
  primary: PriceSnapshot,
  fallback: PriceSnapshot,
  nowMs = Date.now(),
): PriceSnapshot {
  const primaryQuotes = primary.quotes.map((quote) => ({ ...quote }));
  const primaryByKey = new Map<string, number>();
  primaryQuotes.forEach((quote, index) => {
    for (const key of quoteIdentityKeys(quote)) if (!primaryByKey.has(key)) primaryByKey.set(key, index);
  });
  const fallbackKeys = new Set<string>();
  const fallbackQuotes: PriceQuote[] = [];
  for (const quote of fallback.quotes) {
    const keys = quoteIdentityKeys(quote);
    const primaryIndex = keys.map((key) => primaryByKey.get(key)).find((index) => index !== undefined);
    if (primaryIndex !== undefined) {
      // 只补齐名称，不改变主数据源的价格；这样中文易刷价仍可借国服旧源获得英文别名。
      const primaryQuote = primaryQuotes[primaryIndex];
      if (!primaryQuote.englishName && quote.englishName) primaryQuote.englishName = quote.englishName;
      if (!primaryQuote.itemName && quote.itemName) primaryQuote.itemName = quote.itemName;
      for (const key of quoteIdentityKeys(primaryQuote)) if (!primaryByKey.has(key)) primaryByKey.set(key, primaryIndex);
      continue;
    }
    if (!keys.length || keys.some((key) => fallbackKeys.has(key))) continue;
    fallbackQuotes.push(quote);
    for (const key of keys) fallbackKeys.add(key);
  }
  return snapshotFromQuotes([...primaryQuotes, ...fallbackQuotes], nowMs);
}

function responseSourceTime(response: FetchResponse, nowMs: number): string {
  const header = response.headers?.get("date") || response.headers?.get("Date") || "";
  const parsed = Date.parse(header);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(nowMs).toISOString();
}

function responseFileSourceTime(response: FetchResponse, nowMs: number): string {
  const header = response.headers?.get("last-modified") || response.headers?.get("Last-Modified") || "";
  const parsed = parseHttpTime(header);
  if (parsed == null) throw new Error("易刷国服价表缺少更新时间");
  if (nowMs - parsed > MAX_PRICE_AGE_MS) throw new Error("易刷国服价表已超过 24 小时未更新");
  return new Date(parsed).toISOString();
}

async function mapLimited<T, U>(items: readonly T[], limit: number, run: (item: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await run(items[index]);
    }
  }
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return output;
}

export class PoeCurrencyPriceSource {
  constructor(private readonly request: PriceFetch = defaultFetch) {}

  private async requestJson(url: string, signal: AbortSignal, label: string): Promise<FetchResponse> {
    const response = await this.request(url, {
      signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    if (!response.ok) throw new Error(`${label}请求失败（HTTP ${response.status}）`);
    return response;
  }

  private async fetchChina(signal: AbortSignal, nowMs: number): Promise<PriceSnapshot> {
    const response = await this.requestJson(POE_CURRENCY_SUMMARY_URL, signal, "国服行情接口");
    return parsePriceSummary(await response.json(), nowMs);
  }

  private async fetchEfarm(signal: AbortSignal, nowMs: number): Promise<PriceSnapshot> {
    const errors: string[] = [];
    for (const url of EFARM_PRICE_URLS) {
      if (signal.aborted) throw new Error("易刷国服价表请求已取消");
      try {
        const response = await this.request(url, {
          signal,
          headers: { Accept: "text/plain", "User-Agent": USER_AGENT },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!response.text) throw new Error("响应不支持文本读取");
        const sourceTime = responseFileSourceTime(response, nowMs);
        return parseEfarmPriceFile(await response.text(), sourceTime, nowMs);
      } catch (error) {
        errors.push(`${url}: ${errorText(error)}`);
      }
    }
    throw new Error(`易刷国服价表不可用：${errors.join("；")}`);
  }

  private ninjaJobs(league: string): NinjaJob[] {
    const query = `league=${encodeURIComponent(league)}`;
    return [
      ...POE_NINJA_EXCHANGE_TYPES.map((type) => ({
        kind: "exchange" as const,
        type,
        url: `https://poe.ninja/poe1/api/economy/exchange/current/overview?${query}&type=${encodeURIComponent(type)}`,
      })),
      ...POE_NINJA_STASH_ITEM_TYPES.map((type) => ({
        kind: "item" as const,
        type,
        url: `https://poe.ninja/poe1/api/economy/stash/current/item/overview?${query}&type=${encodeURIComponent(type)}`,
      })),
      ...POE_NINJA_UNIQUE_ITEM_TYPES.map((type) => ({
        kind: "item" as const,
        type,
        url: `https://poe.ninja/poe1/api/economy/stash/current/item/overview?${query}&type=${encodeURIComponent(type)}`,
      })),
    ];
  }

  private async fetchNinja(signal: AbortSignal, nowMs: number): Promise<PriceSnapshot> {
    const leagueResponse = await this.requestJson(POE_NINJA_LEAGUES_URL, signal, "poe.ninja 联盟接口");
    const league = parseNinjaLeague(await leagueResponse.json());
    const results = await mapLimited(this.ninjaJobs(league), NINJA_REQUEST_CONCURRENCY, async (job): Promise<NinjaJobResult> => {
      try {
        const response = await this.requestJson(job.url, signal, `poe.ninja ${job.type} 行情`);
        const payload = await response.json();
        const sourceTime = responseSourceTime(response, nowMs);
        return {
          quotes:
            job.kind === "exchange"
              ? parseNinjaExchangeOverview(payload, job.type, sourceTime)
              : parseNinjaItemOverview(payload, job.type, sourceTime),
          error: "",
        };
      } catch (error) {
        return { quotes: [], error: `${job.type}: ${errorText(error)}` };
      }
    });
    const quotes = results.flatMap((result) => result.quotes);
    const errors = results.map((result) => result.error).filter(Boolean);
    if (!quotes.length) {
      const detail = errors.length ? `：${errors.slice(0, 3).join("；")}` : "";
      throw new Error(`poe.ninja 没有可用的 POE1 当前赛季价格${detail}`);
    }
    if (errors.length) console.warn(`[price-patch] poe.ninja 部分类别不可用：${errors.join("；")}`);
    return snapshotFromQuotes(convertHighChaosPricesToDivine(quotes), nowMs);
  }

  async fetch(nowMs = Date.now()): Promise<PriceSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const [efarm, china, ninja] = await Promise.allSettled([
        this.fetchEfarm(controller.signal, nowMs),
        this.fetchChina(controller.signal, nowMs),
        this.fetchNinja(controller.signal, nowMs),
      ]);
      const timedOut = controller.signal.aborted;
      const available: PriceSnapshot[] = [];
      if (efarm.status === "fulfilled") available.push(efarm.value);
      else console.warn(`[price-patch] 易刷国服价表不可用：${errorText(efarm.reason)}`);
      if (china.status === "fulfilled") available.push(china.value);
      else console.warn(`[price-patch] 国服旧行情不可用：${errorText(china.reason)}`);
      if (ninja.status === "fulfilled") available.push(ninja.value);
      else console.warn(`[price-patch] poe.ninja 兜底行情不可用：${errorText(ninja.reason)}`);
      if (!available.length) {
        if (timedOut) throw new Error("行情接口请求超时");
        throw new Error(
          `没有可用行情：${errorText(efarm.status === "rejected" ? efarm.reason : "")}；`
          + `${errorText(china.status === "rejected" ? china.reason : "")}；`
          + `${errorText(ninja.status === "rejected" ? ninja.reason : "")}`,
        );
      }
      return available.slice(1).reduce(
        (merged, fallback) => mergePriceSnapshots(merged, fallback, nowMs),
        available[0],
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
