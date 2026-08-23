import { describe, expect, it } from "vitest";
import {
  clientEnhancementStateFrom,
  clientEnhancementView,
  defaultClientEnhancementState,
} from "../types";

describe("客户端增强界面状态", () => {
  it("单独暴露待应用修改，不把它当成已排队写客户端", () => {
    const state = defaultClientEnhancementState();
    state.viewDistanceEnabled = true;
    state.dirty = true;

    const view = clientEnhancementView(state);
    expect(view.has_changes).toBe(true);
    expect(view.pending).toBe(false);
    expect(view.busy).toBe(false);
    expect(view.environment_defog_enabled).toBe(false);
  });

  it("升级旧配置时取消由切换开关产生的自动应用队列", () => {
    const state = clientEnhancementStateFrom({
      schemaVersion: 1,
      viewDistanceEnabled: true,
      viewDistanceMultiplier: 3,
      pending: true,
      phase: "waiting",
      statusText: "等待游戏退出后应用增强设置",
    });

    expect(state.schemaVersion).toBe(2);
    expect(state.viewDistanceEnabled).toBe(true);
    expect(state.dirty).toBe(true);
    expect(state.pending).toBe(false);
    expect(state.phase).toBe("idle");
    expect(state.statusText).toContain("点击“应用”");
  });

  it("保存并暴露环境去雾开关", () => {
    const state = clientEnhancementStateFrom({
      schemaVersion: 2,
      environmentDefogEnabled: true,
    });

    expect(state.environmentDefogEnabled).toBe(true);
    expect(clientEnhancementView(state).environment_defog_enabled).toBe(true);
  });
});
