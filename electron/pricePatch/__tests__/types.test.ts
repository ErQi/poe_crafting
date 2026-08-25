import { describe, expect, it } from "vitest";
import { defaultPricePatchState, pricePatchView, priceSuffix } from "../types";

describe("标价补丁界面状态", () => {
  it("价格后缀以易刷可剥离的 [价] 形式紧贴名字", () => {
    expect(priceSuffix("1c")).toBe("[1c]");
    expect(priceSuffix("1.18d")).toBe("[1.18d]");
    expect(priceSuffix("0.9d")).toBe("[0.9d]");
  });

  it("暴露客户端路径，并在补丁已应用时锁定修改", () => {
    const state = defaultPricePatchState();
    state.clientRoot = "D:\\Games\\Path of Exile";
    state.applied = true;

    const view = pricePatchView(state);
    expect(view.client_root).toBe(state.clientRoot);
    expect(view.client_root_locked).toBe(true);
  });

  it("等待执行或正在写文件时锁定客户端路径", () => {
    const waiting = defaultPricePatchState();
    waiting.pendingAction = "apply";
    expect(pricePatchView(waiting).client_root_locked).toBe(true);

    const applying = defaultPricePatchState();
    applying.phase = "applying";
    expect(pricePatchView(applying).client_root_locked).toBe(true);
  });
});
