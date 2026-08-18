<script setup>
defineProps({
  startKey: { type: String, default: "F7" },
  stopKey: { type: String, default: "F8" },
});
</script>

<template>
  <div class="help scroll">
    <section class="card span2">
      <div class="h">两套工艺</div>
      <p>本工具有两套独立流程：<b>花园工艺</b> 和 <b>普通工艺</b>。在哪个页点「开始」或按开始热键，就跑哪一套。</p>
      <p>本页和「设置」页按开始热键（默认 {{ startKey }}）<b>不会</b>启动。停止热键（默认 {{ stopKey }}）任何页都可用。</p>
    </section>

    <section class="card">
      <div class="h">花园工艺</div>
      <p>先在游戏园艺台<b>选好要重复的工艺</b>，再点「开始花园」或按开始热键。</p>
      <p>开始后只做三件事：点执行按钮、读取装备、对照目标规则。不自动选工艺，也不判断生命力。</p>
      <p>请先配好至少一条启用的非空目标条件，并保存规则。</p>
    </section>

    <section class="card">
      <div class="h">普通工艺</div>
      <p>多步骤通货循环。每步动作：<b>右键通货 → 左键装备 → Ctrl+C</b> 读结果。</p>
      <p>上方用「组」下拉选分类，再点流程名切换当前流程。可新建 / 复制 / 删除，改完点「保存流程」。</p>
      <p>每步选通货、动作后稀有度，以及命中 / 未命中后的去向（下一步、重复、跳转、完成、停止）。</p>
    </section>

    <section class="card">
      <div class="h">规则怎么配</div>
      <p>每条条件：词缀<b>包含文本</b> + 可选算子和阈值（如 <code>&gt;=</code> <code>80</code>，取该行第一个数字）。文本可用空格或逗号写多个关键字。</p>
      <p>组内可选 AND / OR，或「至少匹配 N 条」。组间也可选 AND（全部组）或 OR（任一组）。</p>
      <p>花园：整页一套规则。普通：每步各有一套；命中条件留空则只看稀有度。</p>
    </section>

    <section class="card">
      <div class="h">设置</div>
      <p>最大次数、动作延迟、工艺等待、模板阈值，以及开始 / 停止热键。改完写入 <code>config/settings.json</code>。</p>
      <p>热键以本页填写为准（默认 {{ startKey }} 开始、{{ stopKey }} 停止）。此页按开始热键不启动工艺。</p>
    </section>

    <section class="card">
      <div class="h">模板</div>
      <p>需要自截两张：<b>装备格</b>（<code>item_slot</code>）和<b>执行按钮</b>（<code>craft_button</code>）。基础通货图标已内置，普通工艺不必再截通货。</p>
      <p>游戏里 <code>Win+Shift+S</code> 截图 → 模板页 <code>Ctrl+V</code> → 选好目标后保存。可用「测试模板匹配」核对分数。</p>
    </section>

    <section class="card">
      <div class="h">游戏与热键</div>
      <p>游戏建议<b>窗口或无边框</b>，不要用互斥全屏。目标装备和会用到的通货要在当前画面可见。</p>
      <p>开始 / 停止热键以设置为准（默认 {{ startKey }} / {{ stopKey }}）。部分环境模拟键鼠需要以管理员身份运行。</p>
    </section>
  </div>
</template>

<style scoped>
.help {
  height: 100%;
  overflow: auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  align-content: start;
}
.span2 { grid-column: 1 / -1; }
.card {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
p { margin: 0; line-height: 1.55; }
code {
  font-family: Consolas, "Cascadia Mono", "Microsoft YaHei", monospace;
  font-size: 12px;
  color: #c8d4e4;
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
}
@media (max-width: 860px) {
  .help { grid-template-columns: 1fr; }
  .span2 { grid-column: auto; }
}
</style>
