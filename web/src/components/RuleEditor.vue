<script setup>
import { computed, ref, watch } from "vue";
import UiSelect from "./UiSelect.vue";
import {
  cloneRuleset,
  emptyGroup,
  emptyRule,
  formatThreshold,
  parseThreshold,
} from "../rules.js";

const props = defineProps({
  modelValue: { type: Object, required: true },
  title: { type: String, default: "命中条件" },
  ops: { type: Array, default: () => ["", ">=", ">", "<=", "<", "="] },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "prompt"]);

const rs = ref(cloneRuleset(props.modelValue));
const gi = ref(0);
const selected = ref(null);
const thrText = ref([]);

watch(
  () => props.modelValue,
  (v) => {
    rs.value = cloneRuleset(v);
    if (gi.value >= rs.value.groups.length) gi.value = 0;
    syncThr();
  },
);

const group = computed(() => rs.value.groups[gi.value] || rs.value.groups[0]);
const opOpts = computed(() => props.ops.map((o) => ({ value: o, label: o || "(无)" })));
const modeOpts = [
  { value: "all", label: "AND (全部)" },
  { value: "any", label: "OR (任一)" },
];

function syncThr() {
  thrText.value = (group.value?.rules || []).map((r) =>
    formatThreshold(r.threshold, r.threshold2),
  );
}

function chipLabel(g) {
  const mark = g.enabled ? "" : "∅";
  const logic = g.min_matches ? `≥${g.min_matches}` : g.combine === "any" ? "∨" : "∧";
  return `${mark}${g.name}[${logic}]`.slice(0, 18);
}

function flush() {
  emit("update:modelValue", cloneRuleset(rs.value));
}

function pickGroup(i) {
  gi.value = i;
  selected.value = null;
  syncThr();
}

function addGroup() {
  rs.value.groups.push(emptyGroup(`规则组 ${rs.value.groups.length + 1}`));
  gi.value = rs.value.groups.length - 1;
  selected.value = null;
  syncThr();
  flush();
}

function delGroup() {
  if (rs.value.groups.length <= 1) return;
  rs.value.groups.splice(gi.value, 1);
  gi.value = Math.max(0, gi.value - 1);
  selected.value = null;
  syncThr();
  flush();
}

async function renameGroup() {
  const name = await new Promise((resolve) => {
    emit("prompt", { title: "改名", message: "规则组名称:", value: group.value.name, resolve });
  });
  if (name == null) return;
  group.value.name = String(name).trim() || group.value.name;
  flush();
}

function addRule() {
  group.value.rules.push(emptyRule());
  syncThr();
  flush();
}

function delRule() {
  const rules = group.value.rules;
  if (!rules.length) return;
  const i = selected.value != null && selected.value < rules.length ? selected.value : rules.length - 1;
  rules.splice(i, 1);
  selected.value = null;
  syncThr();
  flush();
}

function setMin(raw) {
  const t = String(raw || "").trim();
  if (!t) group.value.min_matches = null;
  else {
    const n = parseInt(t, 10);
    group.value.min_matches = Number.isFinite(n) && n >= 1 ? n : null;
  }
  flush();
}

function setThr(i, text) {
  thrText.value[i] = text;
  const parsed = parseThreshold(text);
  const rule = group.value.rules[i];
  rule.threshold = parsed.threshold;
  rule.threshold2 = parsed.threshold2;
}

syncThr();
</script>

<template>
  <div class="re" :class="{ off: disabled }">
    <div class="bar">
      <span class="h">{{ title }}</span>
      <span class="tiny">组间</span>
      <UiSelect
        v-model="rs.group_combine"
        :options="modeOpts"
        :disabled="disabled"
        class="w118"
        @change="flush"
      />
      <div class="hscroll">
        <button
          v-for="(g, i) in rs.groups"
          :key="g.id"
          type="button"
          class="chip"
          :class="{ on: i === gi }"
          :disabled="disabled"
          @click="pickGroup(i)"
        >
          {{ chipLabel(g) }}
        </button>
      </div>
      <button type="button" class="btn" :disabled="disabled" @click="addGroup">加组</button>
      <button type="button" class="btn danger" :disabled="disabled" @click="delGroup">删组</button>
      <button type="button" class="btn ghost" :disabled="disabled" @click="renameGroup">改名</button>
    </div>

    <div class="tools">
      <label class="check">
        <input v-model="group.enabled" type="checkbox" :disabled="disabled" @change="flush" />
        启用本组
      </label>
      <span class="tiny">组内</span>
      <UiSelect
        v-model="group.combine"
        :options="modeOpts"
        :disabled="disabled"
        class="w118"
        @change="flush"
      />
      <span class="tiny">至少匹配</span>
      <input
        class="ctrl min"
        :value="group.min_matches ?? ''"
        :disabled="disabled"
        placeholder="空"
        @change="setMin($event.target.value)"
      />
      <span class="tiny">条</span>
    </div>

    <div class="table-wrap scroll">
      <div class="table">
        <div class="th">启用</div>
        <div class="th">包含文本</div>
        <div class="th">算子</div>
        <div class="th">阈值</div>
        <div class="th">备注</div>
        <template v-if="!group.rules.length">
          <div class="empty">本组还没有词缀条件<br />点击下方「+ 添加条件」</div>
        </template>
        <template v-else>
          <template v-for="(rule, i) in group.rules" :key="rule.id">
            <div class="cell c0" :class="{ sel: selected === i }" @click="selected = i">
              <input v-model="rule.enabled" type="checkbox" :disabled="disabled" @change="flush" />
            </div>
            <div class="cell" :class="{ sel: selected === i }" @click="selected = i">
              <input v-model="rule.pattern" class="ctrl" :disabled="disabled" @change="flush" />
            </div>
            <div class="cell" :class="{ sel: selected === i }" @click="selected = i">
              <UiSelect v-model="rule.operator" :options="opOpts" :disabled="disabled" @change="flush" />
            </div>
            <div class="cell" :class="{ sel: selected === i }" @click="selected = i">
              <input
                class="ctrl"
                :value="thrText[i]"
                :disabled="disabled"
                @input="setThr(i, $event.target.value)"
                @change="flush"
              />
            </div>
            <div class="cell" :class="{ sel: selected === i }" @click="selected = i">
              <input v-model="rule.note" class="ctrl" :disabled="disabled" @change="flush" />
            </div>
          </template>
        </template>
      </div>
    </div>

    <div class="ops">
      <button type="button" class="btn ok" :disabled="disabled" @click="addRule">+ 添加条件</button>
      <button type="button" class="btn danger" :disabled="disabled" @click="delRule">删除选中</button>
    </div>
    <p class="tiny tip">数字 = 本组命中 N 条即可。文本可用空格/逗号写多关键字。</p>
  </div>
</template>

<style scoped>
.re {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
  gap: 6px;
}
.re.off { pointer-events: none; opacity: 0.7; }
.bar, .tools, .ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.bar .hscroll { flex: 1; }
.w118 { width: 118px; flex: 0 0 118px; }
.min { width: 52px; }
.table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.table {
  display: grid;
  grid-template-columns: 48px minmax(140px, 3fr) 88px 90px minmax(80px, 2fr);
  align-items: stretch;
}
.th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--header);
  color: var(--muted);
  padding: 8px 6px;
  font-size: 12px;
}
.cell {
  background: var(--row);
  padding: 5px 4px;
  border-bottom: 1px solid #1a1d24;
  display: flex;
  align-items: center;
}
.cell.sel { background: var(--row-sel); }
.cell.c0 { justify-content: center; }
.empty {
  grid-column: 1 / -1;
  text-align: center;
  color: var(--muted);
  padding: 28px 8px;
}
.tip {
  flex: 0 1 auto;
  min-height: 0;
  overflow: hidden;
  margin: 0;
}
@media (max-height: 800px) {
  .tip { display: none; }
}
</style>
