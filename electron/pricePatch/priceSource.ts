import { createHash } from "crypto";
import type { PriceQuote, PriceSnapshot } from "./types";

export const POE_CURRENCY_SUMMARY_URL = "https://poecurrency.top/api/summary?version=1";
const MAX_PRICE_AGE_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
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

/** 接口时间没有时区后缀，文档约定为东八区；显式补上，避免系统时区影响过期判断。 */
export function parseSourceTime(value: unknown): number | null {
  const raw = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`;
  const valueMs = Date.parse(iso);
  return Number.isFinite(valueMs) ? valueMs : null;
}

export function formatPrice(value: number, unit: "c" | "d" | "e"): string {
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  const safe = Math.max(unit === "d" ? 0.1 : 0.1, rounded);
  return `${Number.isInteger(safe) ? safe.toFixed(0) : safe.toFixed(1)}${unit}`;
}

function quoteFrom(raw: Record<string, unknown>, category: string, nowMs: number): PriceQuote | null {
  if (raw.error === true) return null;
  const itemName = typeof raw.item_name === "string" ? raw.item_name.trim() : "";
  const englishName = typeof raw.engname === "string" ? raw.engname.trim() : "";
  if (!itemName && !englishName) return null;
  const unitRaw = typeof raw.currency_unit === "string" ? raw.currency_unit.toLowerCase() : "";
  if (unitRaw !== "c" && unitRaw !== "d" && unitRaw !== "e") return null;
  const sourceTime = typeof raw.latest_datetime === "string" ? raw.latest_datetime.trim() : "";
  const sourceMs = parseSourceTime(sourceTime);
  if (sourceMs == null || nowMs - sourceMs > MAX_PRICE_AGE_MS) return null;

  // 标价严格取接口的“最新卖1”；缺失时跳过，避免混入均价或买价。
  const value = finitePositive(raw.latest_sell1);
  if (value == null) return null;
  return {
    itemName,
    englishName,
    category,
    value,
    unit: unitRaw,
    display: formatPrice(value, unitRaw),
    sourceTime,
  };
}

function canonicalDigest(quotes: PriceQuote[]): string {
  const rows = [...quotes]
    .sort((a, b) => `${a.englishName}\0${a.itemName}`.localeCompare(`${b.englishName}\0${b.itemName}`, "en"))
    .map((quote) => [quote.englishName, quote.itemName, quote.display, quote.sourceTime]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function parsePriceSummary(payload: unknown, nowMs = Date.now()): PriceSnapshot {
  if (!Array.isArray(payload)) throw new Error("行情接口返回格式不正确");
  const quotes: PriceQuote[] = [];
  for (const group of payload) {
    if (!group || typeof group !== "object") continue;
    const record = group as Record<string, unknown>;
    const category = typeof record.category_label === "string" ? record.category_label.trim() : "";
    if (!Array.isArray(record.items)) continue;
    for (const item of record.items) {
      if (!item || typeof item !== "object") continue;
      const quote = quoteFrom(item as Record<string, unknown>, category, nowMs);
      if (quote) quotes.push(quote);
    }
  }
  if (!quotes.length) throw new Error("行情接口没有可用的 POE1 国服价格");
  const sourceUpdatedAt = quotes.reduce(
    (latest, quote) => (quote.sourceTime > latest ? quote.sourceTime : latest),
    "",
  );
  return {
    fetchedAt: new Date(nowMs).toISOString(),
    sourceUpdatedAt,
    digest: canonicalDigest(quotes),
    quotes,
  };
}

export class PoeCurrencyPriceSource {
  constructor(private readonly request: PriceFetch = defaultFetch) {}

  async fetch(nowMs = Date.now()): Promise<PriceSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.request(POE_CURRENCY_SUMMARY_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "POE-Tools/price-patch" },
      });
      if (!response.ok) throw new Error(`行情接口请求失败（HTTP ${response.status}）`);
      return parsePriceSummary(await response.json(), nowMs);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("行情接口请求超时");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
