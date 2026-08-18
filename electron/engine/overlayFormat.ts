import { formatThresholdText } from "./matcher";
import { MatchMode, MatchResult, RunStatus, StopReason } from "./models";

export function formatMatchOverlayLine(attempt: number, match: MatchResult): string {
  const active = (match.hits || []).filter((h) => h.reason !== "disabled");
  const total = active.length;
  const okN = active.filter((h) => h.matched).length;
  const outer = match.mode === MatchMode.ANY ? "OR" : "AND";
  const mark = match.success ? "✓" : "·";
  const parts = active.slice(0, 6).map((h) => {
    const m = h.matched ? "✓" : "✗";
    const name = (h.rule.pattern || "?").slice(0, 10);
    let thr = "";
    if (h.rule.operator && (h.rule.threshold != null || h.rule.threshold2 != null)) {
      thr = `${h.rule.operator}${formatThresholdText(h.rule.threshold, h.rule.threshold2)}`;
    }
    return `${m}${name}${thr}`;
  });
  if (total > 6) parts.push("…");
  return `${mark} #${attempt} 满足${okN}/${total} [${outer}] ${parts.join(" ") || "(无条件)"}`;
}

export function formatCompletionOverlayLines(status: RunStatus, reason: string): string[] {
  const mark = status.stopReason === StopReason.SUCCESS ? "✓" : "■";
  const lines = [`${mark} ${reason}`];
  const message = (status.message || "").trim();
  if (message && message !== reason) lines.push(message.slice(0, 80));
  lines.push(`尝试 ${status.attempt} 次`);
  if (status.workflowName) lines.push(status.workflowName.slice(0, 24));
  if (status.workflowStepName) {
    lines.push(`步骤 ${status.workflowStepIndex}. ${status.workflowStepName.slice(0, 20)}`);
  }
  return lines;
}

export const STOP_REASON_TEXT: Record<string, string> = {
  [StopReason.SUCCESS]: "成功：已命中目标",
  [StopReason.USER_STOP]: "已手动停止",
  [StopReason.MAX_ATTEMPTS]: "达到最大尝试次数",
  [StopReason.PARSE_FAILURES]: "连续解析失败",
  [StopReason.TEMPLATE_NOT_FOUND]: "匹配资源未找到",
  [StopReason.CURRENCY_UNAVAILABLE]: "通货已用完或不可用",
  [StopReason.LIFEFORCE_INSUFFICIENT]: "生命力/材料不足",
  [StopReason.UNCHANGED]: "词缀连续无变化",
  [StopReason.WINDOW_NOT_FOUND]: "未找到流放之路窗口",
  [StopReason.WORKFLOW_STOP]: "流程按配置停止",
  [StopReason.ERROR]: "运行异常",
  [StopReason.NOT_STARTED]: "未开始",
};
