<template>
  <div class="filter-group">
    <span v-if="label" class="label">{{ label }}</span>
    <div class="relative" @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)" @keydown.enter.prevent="chooseActive()">
      <div class="relative">
        <input
          :placeholder="placeholder || 'Buscar...'"
          class="input pr-8"
          v-model="inner"
          @focus="open = true; fetchDebounced()"
          @input="onInput"
          @blur="onBlur"
        />
        <button
          v-if="inner"
          type="button"
          class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
          @mousedown.prevent="clear"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <Transition
        enter-active-class="transition duration-100 ease-out"
        enter-from-class="opacity-0 scale-95 -translate-y-1"
        enter-to-class="opacity-100 scale-100 translate-y-0"
        leave-active-class="transition duration-75 ease-in"
        leave-from-class="opacity-100 scale-100"
        leave-to-class="opacity-0 scale-95"
      >
        <div
          v-if="open && suggestions.length"
          class="absolute z-30 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-auto"
        >
          <button
            v-for="(opt, idx) in suggestions"
            :key="opt.value + '_' + idx"
            type="button"
            class="w-full text-left px-3 py-2 text-sm transition-colors"
            :class="idx === active ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'"
            @mousedown.prevent="select(opt)"
            @mousemove="active = idx"
          >
            <span>{{ opt.label }}</span>
            <span v-if="showValue && opt.value !== opt.label" class="ml-1 text-xs text-gray-400">{{ opt.value }}</span>
          </button>
        </div>
      </Transition>
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
  fetcher: { type: Function, required: true },
})

const emit = defineEmits(['update:modelValue', 'select'])

const inner = ref(props.modelValue || '')
const suggestions = ref([])
const open = ref(false)
const active = ref(-1)

watch(() => props.modelValue, v => inner.value = v || '')

let timer = null
function fetchDebounced() {
  clearTimeout(timer)
  timer = setTimeout(doFetch, 250)
}

async function doFetch() {
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
  setTimeout(() => open.value = false, 150)
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

function clear() {
  inner.value = ''
  emit('update:modelValue', '')
  suggestions.value = []
}
</script>
