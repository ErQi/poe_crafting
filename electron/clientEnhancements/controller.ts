import { ClientPatchLock } from "../clientPatchLock";
import { loadJson, resolvePath, saveJson } from "../engine/configStore";
import { isGameRunning } from "../pricePatch/clientLocator";
import { GameRunningError } from "../pricePatch/clientPatcher";
import { ClientEnhancementPatcher } from "./patcher";
import {
  MINIMAP_COLORS,
  VIEW_DISTANCE_MULTIPLIERS,
  clientEnhancementStateFrom,
  clientEnhancementView,
  defaultClientEnhancementState,
  type ClientEnhancementConfig,
  type ClientEnhancementState,
  type ClientEnhancementView,
  type MinimapColor,
  type ViewDistanceMultiplier,
} from "./types";

const TICK_MS = 15_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configFrom(state: ClientEnhancementState): ClientEnhancementConfig {
  return {
    viewDistanceEnabled: state.viewDistanceEnabled,
    viewDistanceMultiplier: state.viewDistanceMultiplier,
    minimapEnabled: state.minimapEnabled,
    minimapColor: state.minimapColor,
    environmentDefogEnabled: state.environmentDefogEnabled,
  };
}

export class ClientEnhancementController {
  private readonly stateFile = resolvePath("config/client-enhancements.json");
  private state: ClientEnhancementState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private notify: (() => void) | null = null;
  private operation: Promise<void> | null = null;

  constructor(
    private readonly patcher = new ClientEnhancementPatcher(),
    private readonly gameRunning: () => Promise<boolean> = isGameRunning,
    private readonly lock = new ClientPatchLock(),
    private readonly preferredClientRoot: () => string = () => "",
  ) {
    this.state = clientEnhancementStateFrom(loadJson(this.stateFile, defaultClientEnhancementState()));
  }

  view(): ClientEnhancementView {
    return clientEnhancementView(this.state);
  }

  start(notify: () => void): void {
    this.notify = notify;
    if (this.state.pending || this.state.pendingRestore) {
      this.state.phase = "waiting";
      this.state.statusText = this.state.pendingRestore ? "等待游戏退出后恢复修改前资源" : "等待游戏退出后应用增强设置";
      this.persist();
    }
    if (!this.timer) this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 1000);
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.notify = null;
  }

  private persist(): void {
    saveJson(this.stateFile, this.state);
    this.notify?.();
  }

  private patch(values: Partial<ClientEnhancementState>): void {
    Object.assign(this.state, values);
    this.persist();
  }

  private waiting(restoring: boolean): void {
    this.patch({
      pending: !restoring,
      pendingRestore: restoring,
      phase: "waiting",
      statusText: restoring ? "游戏运行中，退出后将自动恢复修改前资源" : "游戏运行中，退出后将自动应用增强设置",
      error: "",
    });
  }

  private async startOperation(run: () => Promise<void>): Promise<void> {
    if (this.operation) return this.operation;
    this.operation = this.lock.run("客户端增强", run).finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  private rootHint(): string {
    if (this.state.applied && this.state.clientRoot) return this.state.clientRoot;
    return this.preferredClientRoot() || this.state.clientRoot;
  }

  private async runApply(): Promise<void> {
    this.patch({ phase: "applying", statusText: "正在备份并应用客户端增强…", error: "" });
    try {
      const clientRoot = await this.patcher.clientRoot(this.rootHint());
      const config = configFrom(this.state);
      const result = await this.patcher.apply(clientRoot, this.state, config);
      const anyEnabled = config.viewDistanceEnabled || config.minimapEnabled || config.environmentDefogEnabled;
      this.patch({
        clientRoot,
        baselineId: result.baselineId,
        executableSha256: result.executableSha256,
        appliedResourceSha256: result.resourceSha256,
        applied: true,
        dirty: false,
        pending: false,
        pendingRestore: false,
        phase: "idle",
        statusText: anyEnabled
          ? result.changed ? "客户端增强已应用，重启游戏后生效" : "客户端增强设置已是最新"
          : "三项增强均已关闭，相关资源已还原",
        lastAppliedAt: new Date().toISOString(),
        error: "",
      });
    } catch (error) {
      if (error instanceof GameRunningError) {
        this.waiting(false);
        return;
      }
      const message = errorText(error);
      this.patch({ pending: false, phase: "error", statusText: `应用失败：${message}`, error: message });
      throw error;
    }
  }

  private async runRestore(): Promise<void> {
    this.patch({ phase: "restoring", statusText: "正在校验备份并恢复修改前资源…", error: "" });
    try {
      const clientRoot = await this.patcher.clientRoot(this.rootHint());
      const result = await this.patcher.restore(clientRoot, this.state);
      this.patch({
        clientRoot,
        baselineId: result.baselineId,
        executableSha256: result.executableSha256,
        appliedResourceSha256: {},
        applied: false,
        dirty: this.state.viewDistanceEnabled || this.state.minimapEnabled || this.state.environmentDefogEnabled,
        pending: false,
        pendingRestore: false,
        phase: "idle",
        statusText: result.changed ? "已恢复到 POE Tools 首次修改前的客户端资源" : "客户端资源已是修改前状态",
        lastAppliedAt: new Date().toISOString(),
        error: "",
      });
    } catch (error) {
      if (error instanceof GameRunningError) {
        this.waiting(true);
        return;
      }
      const message = errorText(error);
      this.patch({ pendingRestore: false, phase: "error", statusText: `恢复失败：${message}`, error: message });
      throw error;
    }
  }

  private async tick(): Promise<void> {
    if (this.operation || (!this.state.pending && !this.state.pendingRestore)) return;
    if (await this.gameRunning()) return;
    try {
      if (this.state.pendingRestore) await this.startOperation(() => this.runRestore());
      else await this.startOperation(() => this.runApply());
    } catch {
      // 完整错误已写入状态。
    }
  }

  async update(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.operation) {
      return { ok: false, error: "客户端增强正在处理中", client_enhancements: this.view() };
    }
    const next: Partial<ClientEnhancementState> = {};
    if ("view_distance_enabled" in values) next.viewDistanceEnabled = Boolean(values.view_distance_enabled);
    if ("minimap_enabled" in values) next.minimapEnabled = Boolean(values.minimap_enabled);
    if ("environment_defog_enabled" in values) {
      next.environmentDefogEnabled = Boolean(values.environment_defog_enabled);
    }
    if ("view_distance_multiplier" in values) {
      const multiplier = Number(values.view_distance_multiplier) as ViewDistanceMultiplier;
      if (!VIEW_DISTANCE_MULTIPLIERS.includes(multiplier)) {
        return { ok: false, error: "不支持的视距倍率", client_enhancements: this.view() };
      }
      next.viewDistanceMultiplier = multiplier;
    }
    if ("minimap_color" in values) {
      const color = String(values.minimap_color) as MinimapColor;
      if (!MINIMAP_COLORS.includes(color)) {
        return { ok: false, error: "不支持的小地图颜色", client_enhancements: this.view() };
      }
      next.minimapColor = color;
    }
    if (!Object.keys(next).length) return { ok: true, client_enhancements: this.view() };
    const changed = Object.entries(next).some(
      ([key, value]) => this.state[key as keyof ClientEnhancementState] !== value,
    );
    if (!changed) return { ok: true, client_enhancements: this.view() };
    this.patch({
      ...next,
      dirty: true,
      pending: false,
      pendingRestore: false,
      phase: "idle",
      statusText: "增强设置已修改，点击“应用”后写入客户端",
      error: "",
    });
    return { ok: true, client_enhancements: this.view() };
  }

  async apply(): Promise<Record<string, unknown>> {
    if (this.operation) {
      return { ok: false, error: "客户端增强正在处理中", client_enhancements: this.view() };
    }
    if (await this.gameRunning()) {
      this.waiting(false);
      return { ok: true, client_enhancements: this.view() };
    }
    try {
      await this.startOperation(() => this.runApply());
      return { ok: true, client_enhancements: this.view() };
    } catch (error) {
      return { ok: false, error: errorText(error), client_enhancements: this.view() };
    }
  }

  async restore(): Promise<Record<string, unknown>> {
    if (!this.state.baselineId) {
      return { ok: true, client_enhancements: this.view() };
    }
    if (await this.gameRunning()) {
      this.waiting(true);
      return { ok: true, client_enhancements: this.view() };
    }
    try {
      await this.startOperation(() => this.runRestore());
      return { ok: true, client_enhancements: this.view() };
    } catch (error) {
      return { ok: false, error: errorText(error), client_enhancements: this.view() };
    }
  }

  async retry(): Promise<Record<string, unknown>> {
    const restoring = this.state.pendingRestore || this.state.statusText.startsWith("恢复失败");
    this.patch({
      pending: !restoring,
      pendingRestore: restoring,
      phase: "waiting",
      statusText: "正在重试增强设置…",
      error: "",
    });
    return restoring ? this.restore() : this.apply();
  }

  /** 重置增强基线备份：以当前客户端状态为新的还原基准 */
  async resetBaseline(): Promise<Record<string, unknown>> {
    if (this.operation) {
      return { ok: false, error: "客户端增强正在处理中", client_enhancements: this.view() };
    }
    if (await this.gameRunning()) {
      return { ok: false, error: "请先退出游戏再重置增强基线", client_enhancements: this.view() };
    }
    try {
      await this.startOperation(() => this.runResetBaseline());
      return { ok: true, client_enhancements: this.view() };
    } catch (error) {
      return { ok: false, error: errorText(error), client_enhancements: this.view() };
    }
  }

  private async runResetBaseline(): Promise<void> {
    this.patch({ phase: "idle", statusText: "正在重置增强基线备份…", error: "" });
    try {
      const clientRoot = await this.patcher.clientRoot(this.rootHint());
      const result = await this.patcher.resetBaseline(clientRoot);
      const anyEnabled =
        this.state.viewDistanceEnabled || this.state.minimapEnabled || this.state.environmentDefogEnabled;
      this.patch({
        clientRoot,
        baselineId: result.baselineId,
        executableSha256: result.executableSha256,
        appliedResourceSha256: {},
        applied: false,
        dirty: anyEnabled,
        pending: false,
        pendingRestore: false,
        phase: "idle",
        statusText: "已重置增强基线备份，以当前客户端为基准",
        lastAppliedAt: new Date().toISOString(),
        error: "",
      });
    } catch (error) {
      if (error instanceof GameRunningError) return;
      const message = errorText(error);
      this.patch({
        pendingRestore: false,
        phase: "error",
        statusText: `重置增强基线失败：${message}`,
        error: message,
      });
      throw error;
    }
  }
}
