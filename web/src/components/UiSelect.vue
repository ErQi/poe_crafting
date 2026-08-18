<script setup>
import { computed, onBeforeUnmount, ref } from "vue";

const props = defineProps({
  modelValue: { type: [String, Number], default: "" },
  options: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "change"]);
const open = ref(false);
const root = ref(null);

const items = computed(() =>
  props.options.map((opt) =>
    typeof opt === "object" ? opt : { value: opt, label: opt === "" ? "(无)" : String(opt) },
  ),
);
const label = computed(() => {
  const hit = items.value.find((o) => String(o.value) === String(props.modelValue));
  return hit ? hit.label : String(props.modelValue ?? "");
});

function pick(opt) {
  emit("update:modelValue", opt.value);
  emit("change", opt.value);
  open.value = false;
}

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
}

function onDoc(ev) {
  if (root.value && !root.value.contains(ev.target)) open.value = false;
}
document.addEventListener("mousedown", onDoc);
onBeforeUnmount(() => document.removeEventListener("mousedown", onDoc));
</script>

<template>
  <div ref="root" class="select" :class="{ 'is-off': disabled, open }">
    <button type="button" class="select-face" :disabled="disabled" @click="toggle">
      <span>{{ label }}</span>
      <i>▾</i>
    </button>
    <div v-if="open" class="menu">
      <button
        v-for="opt in items"
        :key="String(opt.value)"
        type="button"
        :class="{ on: String(opt.value) === String(modelValue) }"
        @click="pick(opt)"
      >
        {{ opt.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.select { position: relative; min-width: 0; }
.select-face {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
  width: 100%;
}
.select-face span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.select-face i { color: var(--muted); font-style: normal; }
.menu {
  position: absolute;
  z-index: 30;
  left: 0;
  right: 0;
  top: calc(100% + 2px);
  max-height: 240px;
  overflow: auto;
  background: var(--raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
}
.menu button {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  padding: 7px 10px;
}
.menu button:hover, .menu button.on { background: var(--accent); color: #fff; }
</style>
