import { describe, expect, it } from "vitest";
import { MatchMode, MatchResult, MatchRule, RuleHit, RunStatus, StopReason } from "../models";
import { formatCompletionOverlayLines, formatMatchOverlayLine, STOP_REASON_TEXT } from "../overlayFormat";

function hit(pattern: string, matched: boolean, operator = ">=", threshold: number | null = 130, threshold2: number | null = null) {
  return new RuleHit({
    rule: new MatchRule({ pattern, operator, threshold, threshold2 }),
    matched,
    actualValue: threshold,
    actualValues: threshold == null ? [] : [threshold],
    reason: matched ? "数值匹配" : "数值未达标",
  });
}

function result(mode: string, success: boolean, hits: RuleHit[]) {
  return new MatchResult({ success, mode, hits });
}

// 浮窗是运行中唯一的可见反馈；任何裸英文枚举漏出去用户都看不懂
describe("STOP_REASON_TEXT", () => {
  it("覆盖 StopReason 的每一个取值", () => {
    for (const value of Object.values(StopReason)) {
      expect(STOP_REASON_TEXT[value], `缺少 ${value} 的中文文案`).toBeTruthy();
    }
  });

  it("没有多余的键", () => {
    expect(Object.keys(STOP_REASON_TEXT).sort()).toEqual([...Object.values(StopReason)].sort());
  });

  it("文案里不含裸英文枚举", () => {
    for (const [key, text] of Object.entries(STOP_REASON_TEXT)) {
      expect(text, `${key} 的文案含英文: ${text}`).not.toMatch(/[A-Za-z_]/);
    }
  });
});

describe("formatMatchOverlayLine", () => {
  it("成功时打勾并统计满足条数", () => {
    const line = formatMatchOverlayLine(3, result(MatchMode.ALL, true, [hit("最大生命", true)]));
    expect(line).toBe("✓ #3 满足1/1 [AND] ✓最大生命>=130");
  });

  it("未成功时用中点，ANY 显示 OR", () => {
    const line = formatMatchOverlayLine(1, result(MatchMode.ANY, false, [hit("最大生命", false), hit("火焰抗性", true, ">=", 46)]));
    expect(line).toBe("· #1 满足1/2 [OR] ✗最大生命>=130 ✓火焰抗性>=46");
  });

  it("被禁用的规则不计入统计也不显示", () => {
    const disabled = new RuleHit({
      rule: new MatchRule({ pattern: "混沌抗性", enabled: false }),
      matched: true,
      reason: "disabled",
    });
    const line = formatMatchOverlayLine(2, result(MatchMode.ALL, true, [hit("最大生命", true), disabled]));
    expect(line).toBe("✓ #2 满足1/1 [AND] ✓最大生命>=130");
  });

  it("没有可显示条件时写「(无条件)」", () => {
    expect(formatMatchOverlayLine(1, result(MatchMode.ALL, false, []))).toBe("· #1 满足0/0 [AND] (无条件)");
  });

  it("双阈值写成区间", () => {
    const line = formatMatchOverlayLine(1, result(MatchMode.ALL, true, [hit("基础冰霜伤害", true, ">=", 6, 12)]));
    expect(line).toContain("✓基础冰霜伤害>=6-12");
  });

  it("没有算子时不显示阈值", () => {
    const line = formatMatchOverlayLine(1, result(MatchMode.ALL, true, [hit("全属性", true, "", 18)]));
    expect(line).toBe("✓ #1 满足1/1 [AND] ✓全属性");
  });

  it("规则名超过 10 个字会截断", () => {
    const line = formatMatchOverlayLine(1, result(MatchMode.ALL, true, [hit("一二三四五六七八九十十一十二", true)]));
    expect(line).toContain("✓一二三四五六七八九十>=130");
    expect(line).not.toContain("十一");
  });

  it("超过 6 条只显示前 6 条并追加省略号", () => {
    const hits = Array.from({ length: 8 }, (_, i) => hit(`条件${i}`, i % 2 === 0));
    const line = formatMatchOverlayLine(9, result(MatchMode.ALL, false, hits));
    expect(line).toContain("满足4/8");
    expect(line.endsWith("…")).toBe(true);
    expect(line).toContain("条件5");
    expect(line).not.toContain("条件6");
  });
});

describe("formatCompletionOverlayLines", () => {
  function status(patch: Partial<RunStatus>): RunStatus {
    const s = new RunStatus();
    Object.assign(s, patch);
    return s;
  }

  it("成功时打勾，并依次给出消息、次数、流程名和步骤", () => {
    const lines = formatCompletionOverlayLines(
      status({
        stopReason: StopReason.SUCCESS,
        message: "流程完成：步骤「富豪尝试补齐两条目标」命中",
        attempt: 7,
        workflowName: "头盔·元素+生命",
        workflowStepName: "富豪尝试补齐两条目标",
        workflowStepIndex: 4,
      }),
      "成功：已命中目标",
    );
    expect(lines).toEqual([
      "✓ 成功：已命中目标",
      "流程完成：步骤「富豪尝试补齐两条目标」命中",
      "尝试 7 次",
      "头盔·元素+生命",
      "步骤 4. 富豪尝试补齐两条目标",
    ]);
  });

  it("非成功用方块标记", () => {
    const lines = formatCompletionOverlayLines(
      status({ stopReason: StopReason.CURRENCY_UNAVAILABLE, attempt: 2 }),
      STOP_REASON_TEXT[StopReason.CURRENCY_UNAVAILABLE],
    );
    expect(lines[0]).toBe("■ 通货已用完或不可用");
    expect(lines).toEqual(["■ 通货已用完或不可用", "尝试 2 次"]);
  });

  it("message 与 reason 相同时不重复一行", () => {
    const lines = formatCompletionOverlayLines(status({ message: "用户停止", attempt: 1 }), "用户停止");
    expect(lines).toEqual(["■ 用户停止", "尝试 1 次"]);
  });

  it("空白 message 不占一行", () => {
    const lines = formatCompletionOverlayLines(status({ message: "   ", attempt: 1 }), "已手动停止");
    expect(lines).toEqual(["■ 已手动停止", "尝试 1 次"]);
  });

  it("超长 message / 流程名 / 步骤名都会截断", () => {
    const lines = formatCompletionOverlayLines(
      status({
        message: "错".repeat(200),
        attempt: 1,
        workflowName: "流".repeat(50),
        workflowStepName: "步".repeat(50),
        workflowStepIndex: 1,
      }),
      "运行异常",
    );
    expect(lines[1].length).toBe(80);
    expect(lines[3].length).toBe(24);
    expect(lines[4]).toBe(`步骤 1. ${"步".repeat(20)}`);
  });
});
