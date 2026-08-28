export type PricePatchPendingAction = "apply" | "update" | "restore" | null;
export type PricePatchPhase = "idle" | "waiting" | "applying" | "restoring" | "error";
export type PriceQuoteSource = "efarm" | "poecurrency" | "poe-ninja";
export type PriceLabelMode = "efarm" | "source";

/** 数值越小优先级越高：易刷国服价 > 旧国服价源 > 国际服 poe.ninja。 */
export function priceQuoteSourcePriority(source: PriceQuoteSource | undefined): number {
  if (source === "efarm") return 0;
  if (source === "poe-ninja") return 2;
  // 未标来源的旧调用继续按国服行情处理。
  return 1;
}

/** 把价格以易刷可剥离的 `名称[价]` 形式追加到物品名后，兼容易刷按纯名查价；
 *  半角方括号紧贴名字、无空格，复制出的物品名可直接被易刷解析成纯名再查价。 */
export function priceSuffix(display: string): string {
  return `[${display}]`;
}

/** 国服价格使用普通中点；poe.ninja 兜底价格使用 ⁙，便于在游戏内直接识别来源。 */
export function priceQuoteSeparator(source: PriceQuoteSource | undefined): " · " | " ⁙ " {
  return source === "poe-ninja" ? " ⁙ " : " · ";
}

/** 易刷模式使用其原生可清理的 [价格] 后缀；来源模式保留国服/国际服符号。 */
export function priceQuoteSuffix(quote: Pick<PriceQuote, "display" | "source">, mode: PriceLabelMode): string {
  return mode === "efarm" ? priceSuffix(quote.display) : `${priceQuoteSeparator(quote.source)}${quote.display}`;
}

export interface PriceQuote {
  itemName: string;
  englishName: string;
  category: string;
  value: number;
  unit: "c" | "d" | "e";
  display: string;
  sourceTime: string;
  source?: PriceQuoteSource;
}

export interface PriceSnapshot {
  fetchedAt: string;
  sourceUpdatedAt: string;
  digest: string;
  quotes: PriceQuote[];
}

export interface AppliedFileFingerprint {
  relativePath: string;
  size: number;
  sha256: string;
}

export interface PricePatchState {
  schemaVersion: 3;
  clientRoot: string;
  baselineId: string;
  applied: boolean;
  autoUpdate: boolean;
  labelMode: PriceLabelMode;
  appliedLabelMode: PriceLabelMode | "";
  pendingAction: PricePatchPendingAction;
  phase: PricePatchPhase;
  statusText: string;
  lastUpdatedAt: string;
  lastCheckedAt: string;
  sourceUpdatedAt: string;
  nextRetryAt: string;
  lastPriceDigest: string;
  lastPatchedResourceSha256: string;
  lastPatchedUniqueWordsSha256: string;
  lastPatchedAuxiliarySha256: string;
  appliedFiles: AppliedFileFingerprint[];
  appliedCustomFiles: string[];
  updatedItemCount: number;
  error: string;
}

export interface PricePatchView {
  client_root: string;
  client_root_locked: boolean;
  applied: boolean;
  auto_update: boolean;
  label_mode: PriceLabelMode;
  applied_label_mode: PriceLabelMode | "";
  label_mode_dirty: boolean;
  pending: boolean;
  pending_action: PricePatchPendingAction;
  phase: PricePatchPhase;
  busy: boolean;
  status: string;
  last_updated_at: string;
  source_updated_at: string;
  updated_item_count: number;
  error: string;
}

export function defaultPricePatchState(): PricePatchState {
  return {
    schemaVersion: 3,
    clientRoot: "",
    baselineId: "",
    applied: false,
    autoUpdate: true,
    labelMode: "efarm",
    appliedLabelMode: "",
    pendingAction: null,
    phase: "idle",
    statusText: "尚未应用",
    lastUpdatedAt: "",
    lastCheckedAt: "",
    sourceUpdatedAt: "",
    nextRetryAt: "",
    lastPriceDigest: "",
    lastPatchedResourceSha256: "",
    lastPatchedUniqueWordsSha256: "",
    lastPatchedAuxiliarySha256: "",
    appliedFiles: [],
    appliedCustomFiles: [],
    updatedItemCount: 0,
    error: "",
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function pricePatchStateFrom(value: unknown): PricePatchState {
  const fallback = defaultPricePatchState();
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Record<string, unknown>;
  const phase = raw.phase;
  const pending = raw.pendingAction;
  const files = Array.isArray(raw.appliedFiles)
    ? raw.appliedFiles
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((item) => ({
          relativePath: text(item.relativePath),
          size: Number(item.size) || 0,
          sha256: text(item.sha256),
        }))
        .filter((item) => item.relativePath && item.sha256)
    : [];
  const labelMode: PriceLabelMode = raw.labelMode === "source" ? "source" : "efarm";
  const appliedLabelMode: PriceLabelMode | "" = raw.appliedLabelMode === "efarm" || raw.appliedLabelMode === "source"
    ? raw.appliedLabelMode
    // 旧版本只有来源标识格式；升级后默认选择易刷模式，但必须等待用户重新应用。
    : Boolean(raw.applied) ? "source" : "";
  return {
    ...fallback,
    schemaVersion: 3,
    clientRoot: text(raw.clientRoot),
    baselineId: text(raw.baselineId),
    applied: Boolean(raw.applied),
    autoUpdate: raw.autoUpdate === undefined ? true : Boolean(raw.autoUpdate),
    labelMode,
    appliedLabelMode,
    pendingAction: pending === "apply" || pending === "update" || pending === "restore" ? pending : null,
    // 进程退出时不可能仍在写文件；重启后把瞬时状态折叠成可恢复状态。
    phase: phase === "waiting" ? "waiting" : phase === "error" ? "error" : "idle",
    statusText: text(raw.statusText) || fallback.statusText,
    lastUpdatedAt: text(raw.lastUpdatedAt),
    lastCheckedAt: text(raw.lastCheckedAt),
    sourceUpdatedAt: text(raw.sourceUpdatedAt),
    nextRetryAt: text(raw.nextRetryAt),
    lastPriceDigest: text(raw.lastPriceDigest),
    lastPatchedResourceSha256: text(raw.lastPatchedResourceSha256),
    lastPatchedUniqueWordsSha256: text(raw.lastPatchedUniqueWordsSha256),
    lastPatchedAuxiliarySha256: text(raw.lastPatchedAuxiliarySha256),
    appliedFiles: files,
    appliedCustomFiles: Array.isArray(raw.appliedCustomFiles)
      ? raw.appliedCustomFiles.map(text).filter(Boolean)
      : [],
    updatedItemCount: Math.max(0, Math.trunc(Number(raw.updatedItemCount) || 0)),
    error: text(raw.error),
  };
}

export function pricePatchView(state: PricePatchState): PricePatchView {
  const busy = state.phase === "applying" || state.phase === "restoring";
  return {
    client_root: state.clientRoot,
    client_root_locked: state.applied || state.pendingAction !== null || busy,
    applied: state.applied,
    auto_update: state.autoUpdate,
    label_mode: state.labelMode,
    applied_label_mode: state.appliedLabelMode,
    label_mode_dirty: state.applied && state.labelMode !== state.appliedLabelMode,
    pending: state.pendingAction !== null,
    pending_action: state.pendingAction,
    phase: state.phase,
    busy,
    status: state.statusText,
    last_updated_at: state.lastUpdatedAt,
    source_updated_at: state.sourceUpdatedAt,
    updated_item_count: state.updatedItemCount,
    error: state.error,
  };
}
