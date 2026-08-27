import { loadJson, resolvePath, saveJson } from "../engine/configStore";
import { ClientPatchLock } from "../clientPatchLock";
import { ClientPricePatcher, GameRunningError } from "./clientPatcher";
import { isGameRunning, normalizePoeClientRoot } from "./clientLocator";
import { PoeCurrencyPriceSource } from "./priceSource";
import {
  defaultPricePatchState,
  pricePatchStateFrom,
  pricePatchView,
  type PriceLabelMode,
  type PricePatchPendingAction,
  type PricePatchState,
  type PricePatchView,
} from "./types";

const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const TICK_MS = 15_000;
const RETRY_MS = 10 * 60 * 1000;

function time(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function labelModeName(mode: PriceLabelMode): string {
  return mode === "efarm" ? "易刷模式" : "来源标识模式";
}

export class PricePatchController {
  private readonly stateFile = resolvePath("config/price-patch.json");
  private state: PricePatchState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private notify: (() => void) | null = null;
  private operation: Promise<void> | null = null;

  constructor(
    private readonly source = new PoeCurrencyPriceSource(),
    private readonly patcher = new ClientPricePatcher(),
    private readonly gameRunning: () => Promise<boolean> = isGameRunning,
    private readonly lock = new ClientPatchLock(),
  ) {
    const loaded = loadJson(this.stateFile, defaultPricePatchState());
    this.state = pricePatchStateFrom(loaded);
  }

  view(): PricePatchView {
    return pricePatchView(this.state);
  }

  configuredClientRoot(): string {
    return this.state.clientRoot;
  }

  start(notify: () => void): void {
    this.notify = notify;
    if (this.state.pendingAction) {
      this.state.phase = "waiting";
      this.state.statusText = this.state.pendingAction === "restore" ? "等待游戏退出后恢复原版" : "等待游戏退出后更新价格";
      this.persist();
    } else if (this.state.applied && this.state.phase !== "error") {
      this.state.phase = "idle";
      this.state.statusText = this.state.labelMode === this.state.appliedLabelMode
        ? "已应用"
        : `${labelModeName(this.state.labelMode)}已选择，点击重新应用后生效`;
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

  private patch(values: Partial<PricePatchState>, persist = true): void {
    Object.assign(this.state, values);
    if (persist) this.persist();
    else this.notify?.();
  }

  private waiting(action: Exclude<PricePatchPendingAction, null>): void {
    const restoring = action === "restore";
    this.patch({
      pendingAction: action,
      phase: "waiting",
      statusText: restoring ? "游戏运行中，退出后将自动恢复原版" : "游戏运行中，退出后将自动应用最新价格",
      error: "",
    });
  }

  private due(now = Date.now()): boolean {
    if (!this.state.applied || !this.state.autoUpdate) return false;
    if (this.state.nextRetryAt && now < time(this.state.nextRetryAt)) return false;
    return !this.state.lastUpdatedAt || now - time(this.state.lastUpdatedAt) >= UPDATE_INTERVAL_MS;
  }

  private async tick(): Promise<void> {
    try {
      if (this.operation) return;
      const action = this.state.pendingAction;
      if (action) {
        if (action === "update" && this.state.nextRetryAt && Date.now() < time(this.state.nextRetryAt)) return;
        if (await this.gameRunning()) return;
        if (action === "restore") await this.startOperation(() => this.runRestore());
        else await this.startOperation(() => this.runApply(action));
        return;
      }
      if (!this.due()) return;
      if (await this.gameRunning()) {
        this.waiting("update");
        return;
      }
      await this.startOperation(() => this.runApply("update"));
    } catch {
      // runApply/runRestore 已把完整错误写入状态；定时器不能再制造未处理拒绝。
    }
  }

  private async startOperation(run: () => Promise<void>): Promise<void> {
    if (this.operation) return this.operation;
    this.operation = this.lock.run("标价补丁", run).finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  private async runApply(action: "apply" | "update"): Promise<void> {
    // 自动更新沿用客户端当前格式；只有用户点击应用才提交刚选择的新模式。
    const appliedLabelMode = action === "update" && this.state.appliedLabelMode
      ? this.state.appliedLabelMode
      : this.state.labelMode;
    this.patch({
      pendingAction: action,
      phase: "applying",
      statusText: action === "apply" ? "正在应用标价补丁…" : "正在更新最新价格…",
      error: "",
    });
    try {
      const clientRoot = await this.patcher.clientRoot(this.state.clientRoot);
      const checkedAt = new Date().toISOString();
      this.patch({ clientRoot, lastCheckedAt: checkedAt }, false);
      const prices = await this.source.fetch();
      const result = await this.patcher.apply(clientRoot, this.state, prices, appliedLabelMode);
      const completedAt = new Date().toISOString();
      const labelModeDirty = this.state.labelMode !== appliedLabelMode;
      this.patch({
        clientRoot,
        baselineId: result.baselineId,
        applied: true,
        pendingAction: null,
        phase: "idle",
        statusText: labelModeDirty
          ? `价格已更新；${labelModeName(this.state.labelMode)}待重新应用`
          : result.skipped ? "已应用，当前价格无需改写" : `已应用，已标价 ${result.matchedCount} 个物品`,
        appliedLabelMode,
        lastUpdatedAt: completedAt,
        lastCheckedAt: completedAt,
        sourceUpdatedAt: prices.sourceUpdatedAt,
        nextRetryAt: "",
        lastPriceDigest: prices.digest,
        lastPatchedResourceSha256: result.patchedResourceSha256,
        lastPatchedUniqueWordsSha256: result.patchedUniqueWordsSha256,
        lastPatchedAuxiliarySha256: result.patchedAuxiliarySha256,
        appliedFiles: result.appliedFiles,
        appliedCustomFiles: result.appliedCustomFiles,
        updatedItemCount: result.matchedCount,
        error: "",
      });
    } catch (error) {
      if (error instanceof GameRunningError) {
        this.waiting(action);
        return;
      }
      const message = errorText(error);
      const retry = action === "update";
      this.patch({
        pendingAction: retry ? "update" : null,
        phase: "error",
        statusText: `应用失败：${message}`,
        nextRetryAt: retry ? new Date(Date.now() + RETRY_MS).toISOString() : "",
        error: message,
      });
      throw error;
    }
  }

  private async runRestore(): Promise<void> {
    this.patch({ pendingAction: "restore", phase: "restoring", statusText: "正在校验备份并恢复原版…", error: "" });
    try {
      const clientRoot = await this.patcher.clientRoot(this.state.clientRoot);
      const result = await this.patcher.restore(clientRoot, this.state);
      this.patch({
        clientRoot,
        baselineId: result.baselineId,
        applied: false,
        appliedLabelMode: "",
        pendingAction: null,
        phase: "idle",
        statusText: result.restored ? "已取消补丁，客户端已恢复原版" : "未应用标价补丁",
        nextRetryAt: "",
        lastPriceDigest: "",
        lastPatchedResourceSha256: "",
        lastPatchedUniqueWordsSha256: "",
        lastPatchedAuxiliarySha256: "",
        appliedFiles: [],
        appliedCustomFiles: [],
        updatedItemCount: 0,
        error: "",
      });
    } catch (error) {
      if (error instanceof GameRunningError) {
        this.waiting("restore");
        return;
      }
      const message = errorText(error);
      this.patch({
        pendingAction: null,
        phase: "error",
        statusText: `恢复失败，客户端未继续改动：${message}`,
        error: message,
      });
      throw error;
    }
  }

  async apply(): Promise<Record<string, unknown>> {
    if (this.operation) return { ok: false, error: "标价补丁正在处理中", price_patch: this.view() };
    if (await this.gameRunning()) {
      this.waiting("apply");
      return { ok: true, price_patch: this.view() };
    }
    try {
      await this.startOperation(() => this.runApply("apply"));
      return { ok: true, price_patch: this.view() };
    } catch (error) {
      return { ok: false, error: errorText(error), price_patch: this.view() };
    }
  }

  async restore(): Promise<Record<string, unknown>> {
    if (this.operation) return { ok: false, error: "标价补丁正在处理中", price_patch: this.view() };
    if (await this.gameRunning()) {
      this.waiting("restore");
      return { ok: true, price_patch: this.view() };
    }
    try {
      await this.startOperation(() => this.runRestore());
      return { ok: true, price_patch: this.view() };
    } catch (error) {
      return { ok: false, error: errorText(error), price_patch: this.view() };
    }
  }

  setAutoUpdate(enabled: boolean): Record<string, unknown> {
    const pendingAction = !enabled && this.state.pendingAction === "update" ? null : this.state.pendingAction;
    this.patch({
      autoUpdate: enabled,
      pendingAction,
      phase: pendingAction ? "waiting" : this.state.phase === "waiting" ? "idle" : this.state.phase,
      statusText: pendingAction
        ? this.state.statusText
        : this.state.applied
          ? this.state.labelMode === this.state.appliedLabelMode
            ? "已应用"
            : `${labelModeName(this.state.labelMode)}已选择，点击重新应用后生效`
          : "尚未应用",
    });
    if (enabled) setTimeout(() => void this.tick(), 0);
    return { ok: true, price_patch: this.view() };
  }

  setLabelMode(value: string): Record<string, unknown> {
    if (this.operation) return { ok: false, error: "标价补丁正在处理中", price_patch: this.view() };
    if (this.state.pendingAction) {
      return { ok: false, error: "已有等待执行的标价操作，完成后再切换模式", price_patch: this.view() };
    }
    const labelMode: PriceLabelMode = value === "source" ? "source" : "efarm";
    this.patch({
      labelMode,
      statusText: this.state.applied
        ? labelMode === this.state.appliedLabelMode
          ? "已应用"
          : `${labelModeName(labelMode)}已选择，点击重新应用后生效`
        : `已选择${labelModeName(labelMode)}，尚未应用`,
      error: "",
    });
    return { ok: true, price_patch: this.view() };
  }

  setClientRoot(value: string): Record<string, unknown> {
    if (this.operation) return { ok: false, error: "标价补丁正在处理中", price_patch: this.view() };
    if (this.state.applied) {
      return { ok: false, error: "请先取消补丁并恢复原版，再修改客户端路径", price_patch: this.view() };
    }
    if (this.state.pendingAction) {
      return { ok: false, error: "已有等待执行的标价操作，暂时不能修改客户端路径", price_patch: this.view() };
    }

    try {
      const input = String(value || "").trim();
      const clientRoot = input ? normalizePoeClientRoot(input) : "";
      const changed = clientRoot.toLocaleLowerCase("en-US") !== this.state.clientRoot.toLocaleLowerCase("en-US");
      this.patch({
        clientRoot,
        baselineId: changed ? "" : this.state.baselineId,
        appliedLabelMode: changed ? "" : this.state.appliedLabelMode,
        phase: "idle",
        statusText: clientRoot ? "客户端路径已保存，尚未应用" : "已改为自动检测客户端，尚未应用",
        lastUpdatedAt: changed ? "" : this.state.lastUpdatedAt,
        lastCheckedAt: changed ? "" : this.state.lastCheckedAt,
        sourceUpdatedAt: changed ? "" : this.state.sourceUpdatedAt,
        nextRetryAt: "",
        lastPriceDigest: changed ? "" : this.state.lastPriceDigest,
        lastPatchedResourceSha256: changed ? "" : this.state.lastPatchedResourceSha256,
        lastPatchedUniqueWordsSha256: changed ? "" : this.state.lastPatchedUniqueWordsSha256,
        lastPatchedAuxiliarySha256: changed ? "" : this.state.lastPatchedAuxiliarySha256,
        appliedFiles: changed ? [] : this.state.appliedFiles,
        appliedCustomFiles: changed ? [] : this.state.appliedCustomFiles,
        updatedItemCount: changed ? 0 : this.state.updatedItemCount,
        error: "",
      });
      return { ok: true, price_patch: this.view() };
    } catch (error) {
      return { ok: false, error: errorText(error), price_patch: this.view() };
    }
  }
}
