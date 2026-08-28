import { describe, expect, it } from "vitest";
import {
  defaultPricePatchState,
  pricePatchStateFrom,
  pricePatchView,
  priceQuoteSeparator,
  priceQuoteSuffix,
  priceSuffix,
} from "../types";

describe("标价补丁界面状态", () => {
  it("价格后缀以易刷可剥离的 [价] 形式紧贴名字", () => {
    expect(priceSuffix("1c")).toBe("[1c]");
    expect(priceSuffix("1.18d")).toBe("[1.18d]");
    expect(priceSuffix("0.9d")).toBe("[0.9d]");
  });

  it("默认使用易刷模式，并生成易刷查价可清理的方括号后缀", () => {
    const state = defaultPricePatchState();
    expect(state.labelMode).toBe("efarm");
    expect(priceQuoteSuffix({ display: "1.2d", source: "efarm" }, "efarm")).toBe("[1.2d]");
    expect(priceQuoteSuffix({ display: "390c", source: "poe-ninja" }, "efarm")).toBe("[390c]");
    expect(priceQuoteSeparator("efarm")).toBe(" · ");
    expect(priceQuoteSeparator("poecurrency")).toBe(" · ");
    expect(priceQuoteSeparator("poe-ninja")).toBe(" ⁙ ");
    expect(priceQuoteSuffix({ display: "390c", source: "poe-ninja" }, "source")).toBe(" ⁙ 390c");
  });

  it("旧版已应用状态迁移后默认选择易刷模式，并提示需要重新应用", () => {
    const state = pricePatchStateFrom({ schemaVersion: 2, applied: true, autoUpdate: true });
    expect(state.schemaVersion).toBe(3);
    expect(state.labelMode).toBe("efarm");
    expect(state.appliedLabelMode).toBe("source");
    expect(pricePatchView(state).label_mode_dirty).toBe(true);
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
