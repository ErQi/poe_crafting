<script setup>
import { ref } from "vue";
import UiSelect from "../components/UiSelect.vue";

const props = defineProps({
  state: { type: Object, required: true },
  runtime: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["paste", "save", "open", "test", "refresh"]);

const selected = ref(props.state.meta.template_slots[0]?.key || "craft_button");
const slotOpts = props.state.meta.template_slots.map((s) => ({
  value: s.key,
  label: `${s.title}  (${s.key}.png)`,
}));
const test = () => props.runtime.template_test || {};
</script>

<template>
  <div class="tpl">
    <header class="head">
      <span class="h" style="font-size: 16px">模板配置</span>
      <span class="tiny">花园 / 普通共用。Win+Shift+S 截图 → Ctrl+V 粘贴 → 保存</span>
    </header>
    <div class="body">
      <section class="card col">
        <div class="h">剪贴板预览</div>
        <div class="preview">
          <img v-if="runtime.pending_preview" :src="runtime.pending_preview" alt="预览" />
          <span v-else>截图后按 Ctrl+V<br />或点下方「从剪贴板粘贴」</span>
        </div>
        <p class="tiny">{{ runtime.pending_info || "未粘贴" }}</p>
        <label class="field">
          <span>保存为</span>
          <UiSelect v-model="selected" :options="slotOpts" />
        </label>
        <div class="row">
          <button type="button" class="btn" :disabled="disabled" @click="$emit('paste')">从剪贴板粘贴</button>
          <button type="button" class="btn ok" :disabled="disabled" @click="$emit('save', selected)">保存到模板</button>
        </div>
        <p class="tiny">
          输入框内 Ctrl+V 仍粘贴文字。<br />
          保存会覆盖同名 png。<br />
          单击右侧卡片可选中保存目标。
        </p>
      </section>

      <section class="card col">
        <div class="h">已保存模板</div>
        <div class="list scroll">
          <button
            v-for="slot in state.templates"
            :key="slot.key"
            type="button"
            class="slot"
            :class="{ on: selected === slot.key }"
            @click="selected = slot.key"
          >
            <img v-if="slot.thumb" :src="slot.thumb" alt="" />
            <div v-else class="miss" :class="{ req: slot.required }">缺失</div>
            <div>
              <b>{{ slot.title }}</b>
              <p :class="slot.exists ? 'ok' : slot.required ? 'bad' : 'tiny'">{{ slot.info }}</p>
            </div>
          </button>
        </div>
      </section>
    </div>
    <footer class="foot">
      <button type="button" class="btn" @click="$emit('open')">打开模板目录</button>
      <button type="button" class="btn" :disabled="test().testing" @click="$emit('test')">测试模板匹配</button>
      <button type="button" class="btn" @click="$emit('refresh')">刷新模板预览</button>
      <span class="tiny" :style="{ color: test().color || '' }">{{ test().status }}</span>
    </footer>
  </div>
</template>

<style scoped>
.tpl { height: 100%; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.head { display: flex; align-items: baseline; gap: 12px; padding: 4px 4px 0; }
.body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 2fr 3fr;
  gap: 10px;
}
.col { display: flex; flex-direction: column; gap: 8px; padding: 12px; min-height: 0; }
.preview {
  min-height: 150px;
  display: grid;
  place-items: center;
  background: #2a2a2a;
  border-radius: 8px;
  color: var(--muted);
  text-align: center;
  overflow: hidden;
}
.preview img { max-width: 100%; max-height: 180px; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.list { flex: 1; }
.slot {
  display: flex;
  gap: 10px;
  width: 100%;
  text-align: left;
  background: var(--raised);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 6px;
  color: var(--text);
}
.slot.on { border-color: #3a86ff; }
.slot img, .miss {
  width: 80px;
  height: 52px;
  object-fit: contain;
  border-radius: 6px;
  background: #2c2c2c;
}
.miss { display: grid; place-items: center; color: var(--muted); }
.miss.req { color: #9b2226; }
.slot b { display: block; }
.slot p { margin: 4px 0 0; font-size: 12px; }
.ok { color: #6a994e; }
.bad { color: #e5383b; }
.foot { display: flex; align-items: center; gap: 8px; padding: 0 4px 4px; }
</style>
