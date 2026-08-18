<script setup>
import { computed } from "vue";

const props = defineProps({
  state: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["settings", "persist", "save-settings"]);

const s = computed(() => props.state.settings);
const thr = computed(() => Number(s.value.template_threshold || 0).toFixed(2));

function persist(patch) {
  emit("persist", patch);
}
</script>

<template>
  <div class="settings">
    <section class="card col">
      <div class="h">通用设置</div>
      <p class="tiny">修改后写入 config/settings.json。此页按开始热键不会启动工艺。</p>
      <div class="form">
        <label class="field">
          <span>最大次数</span>
          <input
            class="ctrl"
            :value="s.max_attempts"
            :disabled="disabled"
            @change="persist({ max_attempts: $event.target.value })"
          />
        </label>
        <label class="field">
          <span>动作延迟 ms</span>
          <input
            class="ctrl"
            :value="s.action_delay_ms"
            :disabled="disabled"
            @change="persist({ action_delay_ms: $event.target.value })"
          />
        </label>
        <label class="field">
          <span>工艺等待 ms</span>
          <input
            class="ctrl"
            :value="s.craft_wait_ms"
            :disabled="disabled"
            @change="persist({ craft_wait_ms: $event.target.value })"
          />
        </label>
        <label class="field">
          <span>模板阈值</span>
          <div class="thr">
            <input
              type="range"
              min="0.5"
              max="0.99"
              step="0.01"
              :value="s.template_threshold"
              :disabled="disabled"
              @input="$emit('settings', { template_threshold: Number($event.target.value) })"
              @change="$emit('save-settings')"
            />
            <b>{{ thr }}</b>
          </div>
        </label>
        <label class="field">
          <span>开始热键</span>
          <input
            class="ctrl"
            :value="s.hotkey_start"
            :disabled="disabled"
            @change="persist({ hotkey_start: $event.target.value })"
          />
        </label>
        <label class="field">
          <span>停止热键</span>
          <input
            class="ctrl"
            :value="s.hotkey_stop"
            :disabled="disabled"
            @change="persist({ hotkey_stop: $event.target.value })"
          />
        </label>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  height: 100%;
  min-height: 0;
  overflow: auto;
}
.col {
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}
.form {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 8px 10px;
  align-items: center;
}
.form .field { display: contents; }
.form .field > span { color: var(--muted); }
.thr { display: flex; align-items: center; gap: 8px; }
.thr input { flex: 1; }
.thr b { width: 40px; font-variant-numeric: tabular-nums; }
</style>
