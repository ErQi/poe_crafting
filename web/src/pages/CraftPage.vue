<script setup>
import { computed } from "vue";
import RuleEditor from "../components/RuleEditor.vue";

const props = defineProps({
  state: { type: Object, required: true },
  runtime: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
});
defineEmits([
  "rules",
  "save-rules",
  "refresh-item",
  "parse-clip",
  "start",
  "stop",
  "prompt",
]);

const meta = computed(() => props.state.meta);
</script>

<template>
  <div class="craft">
    <section class="card col">
      <div class="h">当前装备</div>
      <pre class="log box scroll">{{ runtime.item_preview || state.item_preview }}</pre>
      <div class="row">
        <button type="button" class="btn" :disabled="disabled" @click="$emit('refresh-item')">
          刷新装备 (悬停槽位)
        </button>
        <button type="button" class="btn ghost" :disabled="disabled" @click="$emit('parse-clip')">
          解析当前剪贴板
        </button>
      </div>
      <div class="h">目标规则（多组）</div>
      <div class="rules">
        <RuleEditor
          :model-value="state.ruleset"
          title="目标规则"
          :ops="meta.ops"
          :disabled="disabled"
          @update:model-value="$emit('rules', $event)"
          @prompt="$emit('prompt', $event)"
        />
      </div>
      <button type="button" class="btn" :disabled="disabled" @click="$emit('save-rules')">保存规则</button>
    </section>

    <section class="card col">
      <div class="h">花园设置</div>
      <p class="tiny">收获工艺台 + 生命之力。请先在游戏里选好花园工艺再开始，开始后只点执行按钮。次数、延迟、热键在「设置」。</p>

      <div class="raised run">
        <div class="h status">{{ runtime.status_text || "状态: 空闲" }}</div>
        <div class="row">
          <button type="button" class="btn ok" :disabled="disabled" @click="$emit('start')">
            开始花园 ({{ meta.hotkey_start }})
          </button>
          <button type="button" class="btn danger" :disabled="!runtime.running" @click="$emit('stop')">
            停止 ({{ meta.hotkey_stop }})
          </button>
        </div>
        <pre class="log box scroll">{{ (runtime.logs || []).join("\n") }}</pre>
      </div>
    </section>
  </div>
</template>

<style scoped>
.craft {
  height: 100%;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  min-height: 0;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  min-height: 0;
}
.box {
  margin: 0;
  padding: 8px;
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 6px;
  min-height: 120px;
}
.col > .box { flex: 0 0 auto; max-height: 220px; }
.rules { flex: 1; min-height: 160px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.run {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
}
.run .box { flex: 1; }
.status { font-size: 14px; }
</style>
