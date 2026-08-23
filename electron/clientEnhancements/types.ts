export const VIEW_DISTANCE_MULTIPLIERS = [1.5, 2, 2.5, 3, 3.5, 4, 5] as const;
export type ViewDistanceMultiplier = (typeof VIEW_DISTANCE_MULTIPLIERS)[number];

export const MINIMAP_COLORS = ["default", "purple", "orange", "blue"] as const;
export type MinimapColor = (typeof MINIMAP_COLORS)[number];

export interface ClientEnhancementConfig {
  viewDistanceEnabled: boolean;
  viewDistanceMultiplier: ViewDistanceMultiplier;
  minimapEnabled: boolean;
  minimapColor: MinimapColor;
  environmentDefogEnabled: boolean;
}

export type ClientEnhancementPhase = "idle" | "waiting" | "applying" | "restoring" | "error";

export interface ClientEnhancementState extends ClientEnhancementConfig {
  schemaVersion: 2;
  clientRoot: string;
  baselineId: string;
  applied: boolean;
  dirty: boolean;
  pending: boolean;
  pendingRestore: boolean;
  phase: ClientEnhancementPhase;
  statusText: string;
  lastAppliedAt: string;
  executableSha256: string;
  appliedResourceSha256: Record<string, string>;
  error: string;
}

export interface ClientEnhancementView {
  client_root: string;
  has_backup: boolean;
  view_distance_enabled: boolean;
  view_distance_multiplier: ViewDistanceMultiplier;
  minimap_enabled: boolean;
  minimap_color: MinimapColor;
  environment_defog_enabled: boolean;
  applied: boolean;
  has_changes: boolean;
  pending: boolean;
  phase: ClientEnhancementPhase;
  busy: boolean;
  status: string;
  last_applied_at: string;
  error: string;
}

export function defaultClientEnhancementState(): ClientEnhancementState {
  return {
    schemaVersion: 2,
    clientRoot: "",
    baselineId: "",
    viewDistanceEnabled: false,
    viewDistanceMultiplier: 2,
    minimapEnabled: false,
    minimapColor: "default",
    environmentDefogEnabled: false,
    applied: false,
    dirty: false,
    pending: false,
    pendingRestore: false,
    phase: "idle",
    statusText: "尚未应用客户端增强",
    lastAppliedAt: "",
    executableSha256: "",
    appliedResourceSha256: {},
    error: "",
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isMultiplier(value: unknown): value is ViewDistanceMultiplier {
  return VIEW_DISTANCE_MULTIPLIERS.includes(Number(value) as ViewDistanceMultiplier);
}

function isMinimapColor(value: unknown): value is MinimapColor {
  return MINIMAP_COLORS.includes(value as MinimapColor);
}

export function clientEnhancementStateFrom(value: unknown): ClientEnhancementState {
  const fallback = defaultClientEnhancementState();
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Record<string, unknown>;
  const hashes = raw.appliedResourceSha256;
  // 旧版切换开关会直接排队写客户端；迁移后取消这类自动队列，保留设置并等待用户点击“应用”。
  const legacyQueuedApply = Number(raw.schemaVersion) !== 2 && Boolean(raw.pending) && !Boolean(raw.pendingRestore);
  const pendingRestore = Boolean(raw.pendingRestore);
  const pending = !legacyQueuedApply && Boolean(raw.pending);
  return {
    ...fallback,
    clientRoot: text(raw.clientRoot),
    baselineId: text(raw.baselineId),
    viewDistanceEnabled: Boolean(raw.viewDistanceEnabled),
    viewDistanceMultiplier: isMultiplier(raw.viewDistanceMultiplier) ? Number(raw.viewDistanceMultiplier) as ViewDistanceMultiplier : 2,
    minimapEnabled: Boolean(raw.minimapEnabled),
    minimapColor: isMinimapColor(raw.minimapColor) ? raw.minimapColor : "default",
    environmentDefogEnabled: Boolean(raw.environmentDefogEnabled),
    applied: Boolean(raw.applied),
    dirty: legacyQueuedApply || Boolean(raw.dirty),
    pending,
    pendingRestore,
    // 写文件中的进程若退出，重启后必须重新执行，而不是保留假的 busy 状态。
    phase: pending || pendingRestore ? "waiting" : raw.phase === "error" ? "error" : "idle",
    statusText: legacyQueuedApply
      ? "增强设置已保留，请点击“应用”后写入客户端"
      : text(raw.statusText) || fallback.statusText,
    lastAppliedAt: text(raw.lastAppliedAt),
    executableSha256: text(raw.executableSha256),
    appliedResourceSha256:
      hashes && typeof hashes === "object"
        ? Object.fromEntries(
            Object.entries(hashes as Record<string, unknown>)
              .map(([key, hash]) => [key, text(hash)])
              .filter(([, hash]) => Boolean(hash)),
          )
        : {},
    error: legacyQueuedApply ? "" : text(raw.error),
  };
}

export function clientEnhancementView(state: ClientEnhancementState): ClientEnhancementView {
  return {
    client_root: state.clientRoot,
    has_backup: Boolean(state.baselineId),
    view_distance_enabled: state.viewDistanceEnabled,
    view_distance_multiplier: state.viewDistanceMultiplier,
    minimap_enabled: state.minimapEnabled,
    minimap_color: state.minimapColor,
    environment_defog_enabled: state.environmentDefogEnabled,
    applied: state.applied,
    has_changes: state.dirty,
    pending: state.pending || state.pendingRestore,
    phase: state.phase,
    busy: state.phase === "applying" || state.phase === "restoring",
    status: state.statusText,
    last_applied_at: state.lastAppliedAt,
    error: state.error,
  };
}
