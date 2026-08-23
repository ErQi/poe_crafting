import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientPatchLock } from "../../clientPatchLock";
import type { ClientEnhancementPatcher } from "../patcher";
import { ClientEnhancementController } from "../controller";

const savedStates: unknown[] = [];

vi.mock("../../engine/configStore", () => ({
  resolvePath: () => "client-enhancements.test.json",
  loadJson: (_file: string, fallback: unknown) => fallback,
  saveJson: (_file: string, value: unknown) => savedStates.push(structuredClone(value)),
}));

function setup(gameRunning = false) {
  const applyPatch = vi.fn(async (_clientRoot: string, _state: unknown, _config: unknown) => ({
    baselineId: "baseline-1",
    executableSha256: "exe-hash",
    resourceSha256: { camera: "camera-hash" },
    changed: true,
  }));
  const patcher = {
    clientRoot: vi.fn(async () => "D:\\Games\\Path of Exile"),
    apply: applyPatch,
    restore: vi.fn(),
  } as unknown as ClientEnhancementPatcher;
  const isRunning = vi.fn(async () => gameRunning);
  const controller = new ClientEnhancementController(patcher, isRunning, new ClientPatchLock());
  return { controller, applyPatch, isRunning };
}

describe("客户端增强显式应用", () => {
  beforeEach(() => savedStates.splice(0));

  it("切换开关只保存待应用设置，不调用补丁写入", async () => {
    const { controller, applyPatch, isRunning } = setup();

    const result = await controller.update({ view_distance_enabled: true });

    expect(result.ok).toBe(true);
    expect(applyPatch).not.toHaveBeenCalled();
    expect(isRunning).not.toHaveBeenCalled();
    expect(controller.view()).toMatchObject({
      view_distance_enabled: true,
      has_changes: true,
      pending: false,
      phase: "idle",
    });
  });

  it("只有调用应用接口后才写入当前设置", async () => {
    const { controller, applyPatch } = setup();
    await controller.update({
      view_distance_enabled: true,
      view_distance_multiplier: 3,
      environment_defog_enabled: true,
    });

    const result = await controller.apply();

    expect(result.ok).toBe(true);
    expect(applyPatch).toHaveBeenCalledTimes(1);
    expect(applyPatch.mock.calls[0][2]).toMatchObject({
      viewDistanceEnabled: true,
      viewDistanceMultiplier: 3,
      environmentDefogEnabled: true,
    });
    expect(controller.view()).toMatchObject({ applied: true, has_changes: false, pending: false });
  });

  it("点击应用时游戏正在运行才建立退出后执行队列", async () => {
    const { controller, applyPatch } = setup(true);
    await controller.update({ minimap_enabled: true });

    await controller.apply();

    expect(applyPatch).not.toHaveBeenCalled();
    expect(controller.view()).toMatchObject({ has_changes: true, pending: true, phase: "waiting" });
  });

  it("等待游戏退出期间再次改设置会取消旧提交，要求重新点击应用", async () => {
    const { controller, applyPatch } = setup(true);
    await controller.update({ view_distance_enabled: true });
    await controller.apply();

    await controller.update({ view_distance_multiplier: 3 });

    expect(applyPatch).not.toHaveBeenCalled();
    expect(controller.view()).toMatchObject({ has_changes: true, pending: false, phase: "idle" });
  });
});
