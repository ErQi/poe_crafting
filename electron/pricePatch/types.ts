export type PricePatchPendingAction = "apply" | "update" | "restore" | null;
export type PricePatchPhase = "idle" | "waiting" | "applying" | "restoring" | "error";

export interface PriceQuote {
  itemName: string;
  englishName: string;
  category: string;
  value: number;
  unit: "c" | "d" | "e";
  display: string;
  sourceTime: string;
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
  schemaVersion: 1;
  clientRoot: string;
  baselineId: string;
  applied: boolean;
  autoUpdate: boolean;
  pendingAction: PricePatchPendingAction;
  phase: PricePatchPhase;
  statusText: string;
  lastUpdatedAt: string;
  lastCheckedAt: string;
  sourceUpdatedAt: string;
  nextRetryAt: string;
  lastPriceDigest: string;
  lastPatchedResourceSha256: string;
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
    schemaVersion: 1,
    clientRoot: "",
    baselineId: "",
    applied: false,
    autoUpdate: true,
    pendingAction: null,
    phase: "idle",
    statusText: "尚未应用",
    lastUpdatedAt: "",
    lastCheckedAt: "",
    sourceUpdatedAt: "",
    nextRetryAt: "",
    lastPriceDigest: "",
    lastPatchedResourceSha256: "",
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
  return {
    ...fallback,
    clientRoot: text(raw.clientRoot),
    baselineId: text(raw.baselineId),
    applied: Boolean(raw.applied),
    autoUpdate: raw.autoUpdate === undefined ? true : Boolean(raw.autoUpdate),
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
