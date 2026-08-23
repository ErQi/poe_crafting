import type { PriceQuote } from "./types";

const DAT_MAGIC = Buffer.alloc(8, 0xbb);
const NAME_POINTER_OFFSET = 32;
const MIN_RECORD_SIZE = NAME_POINTER_OFFSET + 8;
const MAX_RECORD_SIZE = 2048;
const MAX_ROWS = 1_000_000;
const PRICE_SUFFIX =
  /(?:【\s*\d+(?:\.\d+)?\s*[cde]\s*】|⌈\s*\d+(?:\.\d+)?\s*[cde]\s*⌋|\s+·\s*\d+(?:\.\d+)?\s*[cde])\s*$/iu;

export interface BaseItemRow {
  index: number;
  id: string;
  name: string;
}

export interface ParsedBaseItemTypes {
  buffer: Buffer;
  rowCount: number;
  recordSize: number;
  dataSectionOffset: number;
  rows: BaseItemRow[];
}

export interface PatchedBaseItemTypes {
  buffer: Buffer;
  matchedCount: number;
  matchedIds: string[];
}

function findDataSection(buffer: Buffer, rowCount: number): { offset: number; recordSize: number } {
  let cursor = 4;
  while (cursor >= 4 && cursor < buffer.length) {
    const offset = buffer.indexOf(DAT_MAGIC, cursor);
    if (offset < 0) break;
    const bytes = offset - 4;
    if (bytes >= 0 && bytes % rowCount === 0) {
      const recordSize = bytes / rowCount;
      if (recordSize >= MIN_RECORD_SIZE && recordSize <= MAX_RECORD_SIZE) return { offset, recordSize };
    }
    cursor = offset + 1;
  }
  throw new Error("BaseItemTypes 数据结构不受支持（找不到记录区边界）");
}

function readPointer(buffer: Buffer, position: number): number {
  const value = buffer.readBigInt64LE(position);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("BaseItemTypes 包含非法字符串偏移");
  return Number(value);
}

function readUtf16String(buffer: Buffer, absoluteOffset: number): string {
  if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset < 0 || absoluteOffset >= buffer.length) {
    throw new Error("BaseItemTypes 字符串偏移越界");
  }
  let end = absoluteOffset;
  while (end + 1 < buffer.length) {
    if (buffer.readUInt16LE(end) === 0) return buffer.toString("utf16le", absoluteOffset, end);
    end += 2;
  }
  throw new Error("BaseItemTypes 字符串缺少结束标记");
}

export function parseBaseItemTypes(input: Buffer): ParsedBaseItemTypes {
  const buffer = Buffer.from(input);
  if (buffer.length < 64) throw new Error("BaseItemTypes 文件过小");
  const rowCount = buffer.readInt32LE(0);
  if (rowCount <= 0 || rowCount > MAX_ROWS) throw new Error("BaseItemTypes 记录数异常");
  const { offset: dataSectionOffset, recordSize } = findDataSection(buffer, rowCount);
  const rows: BaseItemRow[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const record = 4 + index * recordSize;
    const idOffset = readPointer(buffer, record);
    const nameOffset = readPointer(buffer, record + NAME_POINTER_OFFSET);
    rows.push({
      index,
      id: readUtf16String(buffer, dataSectionOffset + idOffset),
      name: readUtf16String(buffer, dataSectionOffset + nameOffset),
    });
  }
  return { buffer, rowCount, recordSize, dataSectionOffset, rows };
}

export function stripPriceSuffix(value: string): string {
  let result = value.trimEnd();
  while (PRICE_SUFFIX.test(result)) result = result.replace(PRICE_SUFFIX, "").trimEnd();
  return result;
}

function key(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function chineseKey(value: string): string {
  return key(stripPriceSuffix(value)).replace(/^[^\p{L}\p{N}]+/u, "");
}

function appendNames(parsed: ParsedBaseItemTypes, updates: Map<number, string>): Buffer {
  if (!updates.size) return Buffer.from(parsed.buffer);
  const output = Buffer.from(parsed.buffer);
  const chunks: Buffer[] = [output];
  const offsets = new Map<string, number>();
  let relativeOffset = output.length - parsed.dataSectionOffset;
  for (const [rowIndex, name] of updates) {
    let offset = offsets.get(name);
    if (offset === undefined) {
      offset = relativeOffset;
      const value = Buffer.concat([Buffer.from(name, "utf16le"), Buffer.alloc(4)]);
      chunks.push(value);
      relativeOffset += value.length;
      offsets.set(name, offset);
    }
    const pointer = 4 + rowIndex * parsed.recordSize + NAME_POINTER_OFFSET;
    output.writeBigInt64LE(BigInt(offset), pointer);
  }
  return Buffer.concat(chunks);
}

function sourcePriority(quote: PriceQuote): number {
  // 未标来源的旧调用按原有国服行情处理，避免升级后改变既有匹配语义。
  return quote.source === "poe-ninja" ? 1 : 0;
}

function keepPreferredQuote(map: Map<string, PriceQuote>, name: string, quote: PriceQuote): void {
  const existing = map.get(name);
  // 同一来源延续原有的“后条目生效”；只有低优先级来源不能覆盖国服。
  if (!existing || sourcePriority(quote) <= sourcePriority(existing)) map.set(name, quote);
}

function preferredQuote(english: PriceQuote | undefined, chinese: PriceQuote | undefined): PriceQuote | undefined {
  if (!english) return chinese;
  if (!chinese) return english;
  const englishPriority = sourcePriority(english);
  const chinesePriority = sourcePriority(chinese);
  // 同一来源仍优先英文名 + 内部 Id；跨来源时国服行情永远优先。
  return chinesePriority < englishPriority ? chinese : english;
}

export function cleanLocalizedBaseItems(input: Buffer): { buffer: Buffer; changedCount: number } {
  const parsed = parseBaseItemTypes(input);
  const updates = new Map<number, string>();
  for (const row of parsed.rows) {
    const clean = stripPriceSuffix(row.name);
    if (clean !== row.name) updates.set(row.index, clean);
  }
  return { buffer: appendNames(parsed, updates), changedCount: updates.size };
}

export function patchLocalizedBaseItems(
  englishInput: Buffer,
  localizedInput: Buffer,
  quotes: PriceQuote[],
): PatchedBaseItemTypes {
  const english = parseBaseItemTypes(englishInput);
  const localized = parseBaseItemTypes(localizedInput);
  if (english.rowCount !== localized.rowCount) throw new Error("中英文 BaseItemTypes 记录数不一致");

  const englishById = new Map(english.rows.map((row) => [row.id, row]));
  const localizedById = new Map(localized.rows.map((row) => [row.id, row]));
  if (localizedById.size !== localized.rowCount) throw new Error("国服 BaseItemTypes 内部 Id 重复");

  const quoteByEnglish = new Map<string, PriceQuote>();
  const quoteByChinese = new Map<string, PriceQuote>();
  for (const quote of quotes) {
    if (quote.englishName) keepPreferredQuote(quoteByEnglish, key(quote.englishName), quote);
    if (quote.itemName) keepPreferredQuote(quoteByChinese, chineseKey(quote.itemName), quote);
  }

  const updates = new Map<number, string>();
  const matchedIds: string[] = [];
  for (const [id, localizedRow] of localizedById) {
    const englishRow = englishById.get(id);
    const quote = preferredQuote(
      englishRow ? quoteByEnglish.get(key(englishRow.name)) : undefined,
      quoteByChinese.get(chineseKey(localizedRow.name)),
    );
    if (!quote) continue;
    const baselineName = stripPriceSuffix(localizedRow.name);
    updates.set(localizedRow.index, `${baselineName} · ${quote.display}`);
    matchedIds.push(id);
  }
  return { buffer: appendNames(localized, updates), matchedCount: matchedIds.length, matchedIds };
}
