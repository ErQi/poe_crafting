import { priceQuoteSeparator, priceQuoteSourcePriority, type PriceQuote } from "./types";
import { localizedNameKeys, stripPriceSuffix } from "./dat64";

const DAT_MAGIC = Buffer.alloc(8, 0xbb);
const WORDLIST_OFFSET = 0;
const WORD_TEXT_OFFSET = 4;
const WORD_LOCALIZED_TEXT_OFFSET = 48;
const UNIQUE_ITEM_WORDLIST = 6;
const MIN_WORD_RECORD_SIZE = WORD_LOCALIZED_TEXT_OFFSET + 8;
const MAX_RECORD_SIZE = 2048;
const MAX_ROWS = 1_000_000;

interface DatLayout {
  rowCount: number;
  recordSize: number;
  dataSectionOffset: number;
}

export interface UniqueWordRow {
  index: number;
  englishName: string;
  localizedName: string;
}

interface UniqueWordEntry extends UniqueWordRow {
  englishAliases: string[];
}

export interface PatchedUniqueWords {
  buffer: Buffer;
  matchedCount: number;
  matchedRows: number[];
}

function findLayout(buffer: Buffer, minimumRecordSize: number): DatLayout {
  if (buffer.length < 64) throw new Error("DAT 文件过小");
  const rowCount = buffer.readInt32LE(0);
  if (rowCount <= 0 || rowCount > MAX_ROWS) throw new Error("DAT 记录数异常");
  let cursor = 4;
  while (cursor >= 4 && cursor < buffer.length) {
    const offset = buffer.indexOf(DAT_MAGIC, cursor);
    if (offset < 0) break;
    const fixedBytes = offset - 4;
    if (fixedBytes >= 0 && fixedBytes % rowCount === 0) {
      const recordSize = fixedBytes / rowCount;
      if (recordSize >= minimumRecordSize && recordSize <= MAX_RECORD_SIZE) {
        return { rowCount, recordSize, dataSectionOffset: offset };
      }
    }
    cursor = offset + 1;
  }
  throw new Error("DAT 数据结构不受支持（找不到记录区边界）");
}

function readPointer(buffer: Buffer, position: number): number {
  const value = buffer.readBigInt64LE(position);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Words 包含非法字符串偏移");
  return Number(value);
}

function readUtf16String(buffer: Buffer, absoluteOffset: number): string {
  if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset < 0 || absoluteOffset >= buffer.length) {
    throw new Error("Words 字符串偏移越界");
  }
  let end = absoluteOffset;
  while (end + 1 < buffer.length) {
    if (buffer.readUInt16LE(end) === 0) return buffer.toString("utf16le", absoluteOffset, end);
    end += 2;
  }
  throw new Error("Words 字符串缺少结束标记");
}

function wordString(buffer: Buffer, layout: DatLayout, row: number, fieldOffset: number): string {
  const record = 4 + row * layout.recordSize;
  const relative = readPointer(buffer, record + fieldOffset);
  return readUtf16String(buffer, layout.dataSectionOffset + relative);
}

function localizedWordName(buffer: Buffer, layout: DatLayout, row: number): string {
  return wordString(buffer, layout, row, WORD_LOCALIZED_TEXT_OFFSET) || wordString(buffer, layout, row, WORD_TEXT_OFFSET);
}

function uniqueWordRows(wordsInput: Buffer, wordsLayout: DatLayout, uniqueLayout: Buffer): number[] {
  const layout = findLayout(uniqueLayout, 8);
  const rows = new Set<number>();
  for (let index = 0; index < layout.rowCount; index += 1) {
    const value = uniqueLayout.readBigInt64LE(4 + index * layout.recordSize);
    if (value >= 0n && value < BigInt(wordsLayout.rowCount)) rows.add(Number(value));
  }
  // UniqueStashLayout 只覆盖仓库页已收录的唯一装备。Words 的 UNIQUE_ITEM
  // 词表还包含新赛季、唯一遗物、地图以及尚未收录的名称，必须同时纳入。
  for (let index = 0; index < wordsLayout.rowCount; index += 1) {
    const record = 4 + index * wordsLayout.recordSize;
    if (wordsInput.readUInt32LE(record + WORDLIST_OFFSET) === UNIQUE_ITEM_WORDLIST) rows.add(index);
  }
  if (!rows.size) throw new Error("Words 没有可用的唯一物品名称");
  return [...rows].sort((a, b) => a - b);
}

function key(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function keepPreferredQuote(map: Map<string, PriceQuote>, identity: string, quote: PriceQuote): void {
  const current = map.get(identity);
  if (!current || priceQuoteSourcePriority(quote.source) < priceQuoteSourcePriority(current.source)) {
    map.set(identity, quote);
  }
}

function preferredQuote(first: PriceQuote | undefined, second: PriceQuote | undefined): PriceQuote | undefined {
  if (!first) return second;
  if (!second) return first;
  return priceQuoteSourcePriority(second.source) < priceQuoteSourcePriority(first.source) ? second : first;
}

function appendLocalizedNames(buffer: Buffer, layout: DatLayout, updates: Map<number, string>): Buffer {
  if (!updates.size) return Buffer.from(buffer);
  const output = Buffer.from(buffer);
  const chunks: Buffer[] = [output];
  const offsets = new Map<string, number>();
  let relativeOffset = output.length - layout.dataSectionOffset;
  for (const [row, name] of updates) {
    let offset = offsets.get(name);
    if (offset === undefined) {
      offset = relativeOffset;
      const encoded = Buffer.concat([Buffer.from(name, "utf16le"), Buffer.alloc(4)]);
      chunks.push(encoded);
      relativeOffset += encoded.length;
      offsets.set(name, offset);
    }
    output.writeBigInt64LE(BigInt(offset), 4 + row * layout.recordSize + WORD_LOCALIZED_TEXT_OFFSET);
  }
  return Buffer.concat(chunks);
}

function parseUniqueWordEntries(
  englishInput: Buffer,
  localizedInput: Buffer,
  uniqueLayoutInput: Buffer,
): UniqueWordEntry[] {
  const english = findLayout(englishInput, MIN_WORD_RECORD_SIZE);
  const localized = findLayout(localizedInput, MIN_WORD_RECORD_SIZE);
  if (english.rowCount !== localized.rowCount) throw new Error("中英文 Words 记录数不一致");
  return uniqueWordRows(englishInput, english, uniqueLayoutInput).map((index) => {
    const englishText = wordString(englishInput, english, index, WORD_TEXT_OFFSET);
    const englishText2 = wordString(englishInput, english, index, WORD_LOCALIZED_TEXT_OFFSET);
    // poe.ninja 使用当前交易名，改名唯一物品通常位于英文 Words.Text2。
    const englishName = englishText2 || englishText;
    const localizedText = wordString(localizedInput, localized, index, WORD_LOCALIZED_TEXT_OFFSET);
    const fallbackText = wordString(localizedInput, localized, index, WORD_TEXT_OFFSET);
    return {
      index,
      englishName,
      englishAliases: [...new Set([englishName, englishText, englishText2].filter(Boolean))],
      localizedName: localizedText || fallbackText || englishName,
    };
  });
}

/** 唯一物品名由 Words 的 UNIQUE_ITEM 词表与 UniqueStashLayout 共同确定；国服显示 Words.Text2。 */
export function parseUniqueWordRows(
  englishInput: Buffer,
  localizedInput: Buffer,
  uniqueLayoutInput: Buffer,
): UniqueWordRow[] {
  return parseUniqueWordEntries(englishInput, localizedInput, uniqueLayoutInput).map(
    ({ index, englishName, localizedName }) => ({ index, englishName, localizedName }),
  );
}

export function cleanLocalizedUniqueWords(
  input: Buffer,
  uniqueLayoutInput: Buffer,
): { buffer: Buffer; changedCount: number } {
  const layout = findLayout(input, MIN_WORD_RECORD_SIZE);
  const updates = new Map<number, string>();
  for (const index of uniqueWordRows(input, layout, uniqueLayoutInput)) {
    const current = wordString(input, layout, index, WORD_LOCALIZED_TEXT_OFFSET);
    const clean = stripPriceSuffix(current);
    if (clean !== current) updates.set(index, clean);
  }
  return { buffer: appendLocalizedNames(input, layout, updates), changedCount: updates.size };
}

/** 与同一 Words 基线相比，只允许唯一物品词表行的 Text2 价格后缀发生变化。 */
export function isPriceSuffixOnlyUniqueWordsVariant(
  baselineInput: Buffer,
  candidateInput: Buffer,
  uniqueLayoutInput: Buffer,
): boolean {
  try {
    const baseline = findLayout(baselineInput, MIN_WORD_RECORD_SIZE);
    const candidate = findLayout(candidateInput, MIN_WORD_RECORD_SIZE);
    if (
      baseline.rowCount !== candidate.rowCount ||
      baseline.recordSize !== candidate.recordSize ||
      baseline.dataSectionOffset !== candidate.dataSectionOffset
    ) {
      return false;
    }

    const baselineData = baselineInput.subarray(baseline.dataSectionOffset);
    if (candidateInput.length - candidate.dataSectionOffset < baselineData.length) return false;
    if (!candidateInput.subarray(candidate.dataSectionOffset, candidate.dataSectionOffset + baselineData.length).equals(baselineData)) {
      return false;
    }

    const uniqueRows = new Set(uniqueWordRows(baselineInput, baseline, uniqueLayoutInput));
    let hasPriceSuffix = false;
    for (let index = 0; index < baseline.rowCount; index += 1) {
      const record = 4 + index * baseline.recordSize;
      if (!uniqueRows.has(index)) {
        if (!baselineInput.subarray(record, record + baseline.recordSize).equals(
          candidateInput.subarray(record, record + candidate.recordSize),
        )) {
          return false;
        }
        continue;
      }

      const baselineName = localizedWordName(baselineInput, baseline, index);
      const candidateName = localizedWordName(candidateInput, candidate, index);
      if (stripPriceSuffix(baselineName) !== stripPriceSuffix(candidateName)) return false;
      if (stripPriceSuffix(candidateName) !== candidateName) hasPriceSuffix = true;
      if (!baselineInput.subarray(record, record + WORD_LOCALIZED_TEXT_OFFSET).equals(
        candidateInput.subarray(record, record + WORD_LOCALIZED_TEXT_OFFSET),
      )) {
        return false;
      }
      if (!baselineInput.subarray(record + WORD_LOCALIZED_TEXT_OFFSET + 8, record + baseline.recordSize).equals(
        candidateInput.subarray(record + WORD_LOCALIZED_TEXT_OFFSET + 8, record + candidate.recordSize),
      )) {
        return false;
      }
    }
    return hasPriceSuffix;
  } catch {
    return false;
  }
}

export function patchLocalizedUniqueWords(
  englishInput: Buffer,
  localizedInput: Buffer,
  uniqueLayoutInput: Buffer,
  quotes: PriceQuote[],
): PatchedUniqueWords {
  const localizedLayout = findLayout(localizedInput, MIN_WORD_RECORD_SIZE);
  const quoteByEnglish = new Map<string, PriceQuote>();
  const quoteByChinese = new Map<string, PriceQuote>();
  const foulbornFallback = new Map<string, PriceQuote>();
  for (const quote of quotes) {
    if (quote.englishName) {
      const identity = key(quote.englishName);
      keepPreferredQuote(quoteByEnglish, identity, quote);
      const strippedFoulborn = quote.englishName.replace(/^Foulborn\s+/iu, "");
      if (strippedFoulborn !== quote.englishName) {
        keepPreferredQuote(foulbornFallback, key(strippedFoulborn), quote);
      }
    }
    if (quote.itemName) {
      for (const identity of localizedNameKeys(quote.itemName)) keepPreferredQuote(quoteByChinese, identity, quote);
    }
  }

  const updates = new Map<number, string>();
  const matchedRows: number[] = [];
  for (const row of parseUniqueWordEntries(englishInput, localizedInput, uniqueLayoutInput)) {
    const aliases = row.englishAliases.map(key);
    const englishQuote = aliases.map((alias) => quoteByEnglish.get(alias)).find(Boolean)
      || aliases.map((alias) => foulbornFallback.get(alias)).find(Boolean);
    const chineseQuote = localizedNameKeys(row.localizedName)
      .map((identity) => quoteByChinese.get(identity))
      .find(Boolean);
    const quote = preferredQuote(englishQuote, chineseQuote);
    if (!quote) continue;
    const baselineName = stripPriceSuffix(row.localizedName);
    updates.set(row.index, `${baselineName}${priceQuoteSeparator(quote.source)}${quote.display}`);
    matchedRows.push(row.index);
  }
  return {
    buffer: appendLocalizedNames(localizedInput, localizedLayout, updates),
    matchedCount: matchedRows.length,
    matchedRows,
  };
}
