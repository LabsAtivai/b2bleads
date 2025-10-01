<template>
  <div class="relative" @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)" @keydown.enter.prevent="chooseActive()">
    <label v-if="label" class="block text-sm font-medium text-slate-700">{{ label }}</label>
    <input
      :placeholder="placeholder"
      class="input mt-1"
      v-model="inner"
      @focus="open = true; fetchDebounced()"
      @input="onInput"
      @blur="onBlur"
    />

    <div
      v-if="open && suggestions.length"
      class="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-64 overflow-auto"
    >
      <button
        v-for="(opt, idx) in suggestions"
        :key="opt.value + '_' + idx"
        type="button"
        class="w-full text-left px-3 py-2 hover:bg-slate-50"
        :class="idx === active ? 'bg-slate-50' : ''"
        @mousedown.prevent="select(opt)"
        @mousemove="active = idx"
      >
        <div class="text-sm">{{ opt.label }}</div>
        <div v-if="showValue" class="text-xs text-slate-500">{{ opt.value }}</div>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  modelValue: String,
  label: String,
  placeholder: String,
  showValue: { type: Boolean, default: false },
  fetcher: { type: Function, required: true }, // (q) => Promise<{value,label}[]>
})

const emit = defineEmits(['update:modelValue', 'select'])

const inner = ref(props.modelValue || '')
const suggestions = ref([])
const open = ref(false)
const active = ref(-1)

watch(() => props.modelValue, v => inner.value = v || '')

function debounce(fn, ms = 300) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

const fetchDebounced = debounce(fetch)

async function fetch() {
  try {
    const list = await props.fetcher(inner.value || '')
    suggestions.value = list
    active.value = list.length ? 0 : -1
  } catch (e) {
    console.error('typeahead fetch err', e)
  }
}

function onInput() {
  emit('update:modelValue', inner.value)
  open.value = true
  fetchDebounced()
}

function onBlur() {
  setTimeout(() => open.value = false, 120)
}

function move(dir) {
  if (!open.value || !suggestions.value.length) return
  const n = suggestions.value.length
  active.value = (active.value + dir + n) % n
}

function chooseActive() {
  if (active.value >= 0 && active.value < suggestions.value.length) {
    select(suggestions.value[active.value])
  }
}

function select(opt) {
  inner.value = opt.value
  emit('update:modelValue', inner.value)
  emit('select', opt)
  open.value = false
}
</script>
