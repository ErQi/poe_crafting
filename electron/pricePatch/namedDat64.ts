import { priceQuoteSourcePriority, priceQuoteSuffix, type PriceLabelMode, type PriceQuote } from "./types";
import { localizedNameKeys, stripPriceSuffix } from "./dat64";

const DAT_MAGIC = Buffer.alloc(8, 0xbb);
const MAX_RECORD_SIZE = 2048;
const MAX_ROWS = 1_000_000;

interface DatLayout {
  rowCount: number;
  recordSize: number;
  dataSectionOffset: number;
}

export interface NamedDatOptions {
  namePointerOffset: number;
  rowIndexes?: readonly number[];
}

export interface NamedDatRow {
  index: number;
  name: string;
}

export interface PatchedNamedDat {
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
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("DAT 包含非法字符串偏移");
  return Number(value);
}

function readUtf16String(buffer: Buffer, absoluteOffset: number): string {
  if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset < 0 || absoluteOffset >= buffer.length) {
    throw new Error("DAT 字符串偏移越界");
  }
  let end = absoluteOffset;
  while (end + 1 < buffer.length) {
    if (buffer.readUInt16LE(end) === 0) return buffer.toString("utf16le", absoluteOffset, end);
    end += 2;
  }
  throw new Error("DAT 字符串缺少结束标记");
}

function selectedRows(layout: DatLayout, rowIndexes?: readonly number[]): number[] {
  if (!rowIndexes) return Array.from({ length: layout.rowCount }, (_, index) => index);
  return [...new Set(rowIndexes)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < layout.rowCount)
    .sort((a, b) => a - b);
}

function rowName(buffer: Buffer, layout: DatLayout, row: number, namePointerOffset: number): string {
  const record = 4 + row * layout.recordSize;
  const relative = readPointer(buffer, record + namePointerOffset);
  return readUtf16String(buffer, layout.dataSectionOffset + relative);
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

function appendNames(
  buffer: Buffer,
  layout: DatLayout,
  namePointerOffset: number,
  updates: Map<number, string>,
): Buffer {
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
    output.writeBigInt64LE(BigInt(offset), 4 + row * layout.recordSize + namePointerOffset);
  }
  return Buffer.concat(chunks);
}

export function parseNamedDatRows(input: Buffer, options: NamedDatOptions): NamedDatRow[] {
  const layout = findLayout(input, options.namePointerOffset + 8);
  return selectedRows(layout, options.rowIndexes).map((index) => ({
    index,
    name: rowName(input, layout, index, options.namePointerOffset),
  }));
}

export function namedDatRowCount(input: Buffer, namePointerOffset: number): number {
  return findLayout(input, namePointerOffset + 8).rowCount;
}

/** 从另一张 DAT 的外键列取出可修改的目标行，用于把野兽标价限制在可捕捉怪物。 */
export function referencedRowIndexes(input: Buffer, targetRowCount: number, referenceOffset = 0): number[] {
  const layout = findLayout(input, referenceOffset + 8);
  const rows = new Set<number>();
  for (let index = 0; index < layout.rowCount; index += 1) {
    const record = 4 + index * layout.recordSize;
    const value = input.readBigInt64LE(record + referenceOffset);
    if (value >= 0n && value < BigInt(targetRowCount)) rows.add(Number(value));
  }
  return [...rows].sort((a, b) => a - b);
}

export function cleanLocalizedNamedDat(
  input: Buffer,
  options: NamedDatOptions,
): { buffer: Buffer; changedCount: number } {
  const layout = findLayout(input, options.namePointerOffset + 8);
  const updates = new Map<number, string>();
  for (const index of selectedRows(layout, options.rowIndexes)) {
    const current = rowName(input, layout, index, options.namePointerOffset);
    const clean = stripPriceSuffix(current);
    if (clean !== current) updates.set(index, clean);
  }
  return {
    buffer: appendNames(input, layout, options.namePointerOffset, updates),
    changedCount: updates.size,
  };
}

/** 只允许指定名称指针及末尾追加的价格字符串改变。 */
export function isPriceSuffixOnlyNamedDatVariant(
  baselineInput: Buffer,
  candidateInput: Buffer,
  options: NamedDatOptions,
): boolean {
  try {
    const baseline = findLayout(baselineInput, options.namePointerOffset + 8);
    const candidate = findLayout(candidateInput, options.namePointerOffset + 8);
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

    const allowedRows = new Set(selectedRows(baseline, options.rowIndexes));
    let hasPriceSuffix = false;
    for (let index = 0; index < baseline.rowCount; index += 1) {
      const record = 4 + index * baseline.recordSize;
      if (!allowedRows.has(index)) {
        if (!baselineInput.subarray(record, record + baseline.recordSize).equals(
          candidateInput.subarray(record, record + candidate.recordSize),
        )) return false;
        continue;
      }
      const baselineName = rowName(baselineInput, baseline, index, options.namePointerOffset);
      const candidateName = rowName(candidateInput, candidate, index, options.namePointerOffset);
      if (stripPriceSuffix(baselineName) !== stripPriceSuffix(candidateName)) return false;
      if (stripPriceSuffix(candidateName) !== candidateName) hasPriceSuffix = true;
      if (!baselineInput.subarray(record, record + options.namePointerOffset).equals(
        candidateInput.subarray(record, record + options.namePointerOffset),
      )) return false;
      if (!baselineInput.subarray(record + options.namePointerOffset + 8, record + baseline.recordSize).equals(
        candidateInput.subarray(record + options.namePointerOffset + 8, record + candidate.recordSize),
      )) return false;
    }
    return hasPriceSuffix;
  } catch {
    return false;
  }
}

export function patchLocalizedNamedDat(
  englishInput: Buffer,
  localizedInput: Buffer,
  quotes: PriceQuote[],
  options: NamedDatOptions,
  labelMode: PriceLabelMode = "efarm",
): PatchedNamedDat {
  const english = findLayout(englishInput, options.namePointerOffset + 8);
  const localized = findLayout(localizedInput, options.namePointerOffset + 8);
  if (english.rowCount !== localized.rowCount) throw new Error("中英文 DAT 记录数不一致");
  const quoteByEnglish = new Map<string, PriceQuote>();
  const quoteByChinese = new Map<string, PriceQuote>();
  for (const quote of quotes) {
    if (quote.englishName) keepPreferredQuote(quoteByEnglish, key(quote.englishName), quote);
    if (quote.itemName) {
      for (const identity of localizedNameKeys(quote.itemName)) keepPreferredQuote(quoteByChinese, identity, quote);
    }
  }

  const updates = new Map<number, string>();
  const matchedRows: number[] = [];
  for (const index of selectedRows(english, options.rowIndexes)) {
    const englishName = rowName(englishInput, english, index, options.namePointerOffset);
    if (!englishName) continue;
    const localizedName = rowName(localizedInput, localized, index, options.namePointerOffset) || englishName;
    const englishQuote = quoteByEnglish.get(key(englishName));
    const chineseQuote = localizedNameKeys(localizedName)
      .map((identity) => quoteByChinese.get(identity))
      .find(Boolean);
    const quote = preferredQuote(englishQuote, chineseQuote);
    if (!quote) continue;
    updates.set(index, `${stripPriceSuffix(localizedName)}${priceQuoteSuffix(quote, labelMode)}`);
    matchedRows.push(index);
  }
  return {
    buffer: appendNames(localizedInput, localized, options.namePointerOffset, updates),
    matchedCount: matchedRows.length,
    matchedRows,
  };
}
