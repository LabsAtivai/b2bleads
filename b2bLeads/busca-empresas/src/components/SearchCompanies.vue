<template>
  <div class="mx-auto max-w-7xl px-4 py-6 lg:py-10">
    <!-- Header com Abas e Ações -->
    <div class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap items-center gap-2">
        <button
          class="btn-ghost"
          :class="activeTab === 'segmento' ? 'ring-2 ring-indigo-500 bg-indigo-50 text-indigo-700' : ''"
          @click="activeTab = 'segmento'"
        >
          Segmento
        </button>
        <button
          class="btn-ghost"
          :class="activeTab === 'cnpj' ? 'ring-2 ring-indigo-500 bg-indigo-50 text-indigo-700' : ''"
          @click="activeTab = 'cnpj'"
        >
          CNPJ
        </button>
        <button
          class="btn-ghost"
          :class="activeTab === 'campo' ? 'ring-2 ring-indigo-500 bg-indigo-50 text-indigo-700' : ''"
          @click="activeTab = 'campo'"
        >
          Campo
        </button>
      </div>

      <div class="toolbar">
        <button class="btn-outline">
          <span class="i">⬇️</span> Exportar
        </button>
        <button class="btn-outline">
          <span class="i">📄</span> Lista
        </button>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[360px,1fr]">
      <!-- Sidebar: Filtros -->
      <aside class="space-y-5">
        <section class="card p-4 sm:p-5">
          <label class="block text-sm font-medium text-slate-700">Ramo de atividade (CNAE)</label>
          <div class="mt-2 flex gap-2">
            <input v-model="filters.cnaePrincipal" type="text" class="input" placeholder="Ex.: 62.01-5/01" />
            <button class="btn-outline" title="Abrir seletor">⋯</button>
          </div>

          <label class="mt-4 flex items-center gap-2">
            <input v-model="filters.buscarCnaeSecundario" type="checkbox" class="checkbox" />
            <span class="text-sm text-slate-700">Buscar CNAE secundário</span>
          </label>

          <label class="mt-4 block text-sm font-medium text-slate-700">Localização</label>
          <div class="mt-2 flex gap-2">
            <input v-model="filters.localizacao" type="text" class="input" placeholder="Cidade, UF ou CEP" />
            <button class="btn-outline" title="Abrir seletor">⋯</button>
          </div>
        </section>

        <section class="card p-4 sm:p-5">
          <h2 class="mb-3 text-sm font-semibold text-slate-800">Características</h2>

          <div class="grid grid-cols-1 gap-4">
            <div>
              <label class="block text-sm font-medium text-slate-700">Situação</label>
              <select v-model="filters.situacao" class="select mt-2">
                <option value="">Todas</option>
                <option value="ATIVA">Ativa</option>
                <option value="INATIVA">Inativa</option>
              </select>
            </div>

            <div>
              <label class="block text-sm font-medium text-slate-700">Tipo</label>
              <select v-model="filters.tipo" class="select mt-2">
                <option value="">Todos</option>
                <option value="MATRIZ">Matriz</option>
                <option value="FILIAL">Filial</option>
              </select>
            </div>

            <div>
              <label class="block text-sm font-medium text-slate-700">Natureza jurídica</label>
              <select v-model="filters.naturezaJuridica" class="select mt-2">
                <option value="">Todas</option>
                <option value="LTDA">LTDA</option>
                <option value="SA">S/A</option>
                <option value="EI">Empresário Individual</option>
              </select>
            </div>

            <div>
              <label class="block text-sm font-medium text-slate-700">Porte</label>
              <select v-model="filters.porte" class="select mt-2">
                <option value="">Todos</option>
                <option value="MEI">MEI</option>
                <option value="ME">ME</option>
                <option value="EPP">EPP</option>
                <option value="DEMAIS">Demais</option>
              </select>
            </div>

            <div>
              <label class="block text-sm font-medium text-slate-700">Capital social</label>
              <input v-model="filters.capitalSocial" type="text" class="input mt-2" placeholder="Ex.: ≥ 100.000" />
            </div>

            <div>
              <label class="block text-sm font-medium text-slate-700">Opção pelo MEI</label>
              <select v-model="filters.opcaoMei" class="select mt-2">
                <option value="">Todas</option>
                <option value="SIM">Sim</option>
                <option value="NAO">Não</option>
              </select>
            </div>

            <div>
              <label class="block text-sm font-medium text-slate-700">Opção pelo Simples</label>
              <select v-model="filters.opcaoSimples" class="select mt-2">
                <option value="">Todas</option>
                <option value="SIM">Sim</option>
                <option value="NAO">Não</option>
              </select>
            </div>

            <div>
              <label class="block text-sm font-medium text-slate-700">Forma de tributação</label>
              <select v-model="filters.tributacao" class="select mt-2">
                <option value="">Todas</option>
                <option value="SIMPLES">Simples</option>
                <option value="LUCRO_PRESUMIDO">Lucro Presumido</option>
                <option value="LUCRO_REAL">Lucro Real</option>
              </select>
            </div>
          </div>

          <div class="mt-5 flex items-center gap-2">
            <button class="btn-primary" @click="onSearch">
              Filtrar
            </button>
            <button class="btn-outline" @click="clearFilters">
              Limpar filtros
            </button>
          </div>
        </section>
      </aside>

      <!-- Resultados -->
      <section class="space-y-4">
        <div class="card p-4 sm:p-5">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 class="text-xl font-semibold text-slate-900">Resultados da pesquisa</h1>
              <p class="text-sm text-slate-600">
                Aproximadamente {{ formattedApprox }} resultados ({{ loadHint }}).
              </p>
            </div>
            <div class="toolbar">
              <button class="btn-outline" @click="exportCsv">
                ⬇️ Exportar CSV
              </button>
              <button class="btn-outline">
                📄 Lista
              </button>
            </div>
          </div>
        </div>

        <!-- Lista -->
        <div v-for="item in results" :key="item.id" class="card p-4 sm:p-5">
          <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div class="space-y-2">
              <span class="badge-success" v-if="item.status === 'ATIVA'">● Ativa</span>
              <span class="badge" v-else>● Inativa</span>

              <h3 class="text-lg font-semibold text-slate-900">
                {{ item.codigo }} {{ item.nome }}
              </h3>

              <div class="flex flex-wrap items-center gap-3 text-sm text-slate-600">
                <span>🗓️ {{ item.atualizadoEm }}</span>
                <span>📍 {{ item.localidade }}</span>
              </div>
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <button class="btn-outline" @click="verEmpresa(item)">Ver empresa</button>
            </div>
          </div>
        </div>

        <!-- Paginação simples (exemplo) -->
        <div class="flex items-center justify-between">
          <button class="btn-outline" :disabled="page === 1" @click="page--">Anterior</button>
          <span class="text-sm text-slate-600">Página {{ page }}</span>
          <button class="btn-outline" @click="page++">Próxima</button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue'

// abas só pra UI
const activeTab = ref('segmento')

// ======= filtros =======
const filters = reactive({
  cnaePrincipal: '',
  buscarCnaeSecundario: true,
  localizacao: '',
  situacao: 'ATIVA',
  tipo: '',
  naturezaJuridica: '',
  porte: '',
  capitalSocial: '',
  opcaoMei: '',
  opcaoSimples: '',
  tributacao: '',
})

// paginação
const page = ref(1)
const pageSize = 10

// estados
const results = ref([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
let aborter /**: AbortController | undefined */ = undefined

// formato do total apenas pra exibir
const formattedApprox = computed(() => Intl.NumberFormat('pt-BR').format(total.value))
const loadHint = computed(() => loading.value ? 'carregando…' : 'ok')

// ===== util: debounce =====
function debounce(fn, ms = 400) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

// monta query com filtros + paginação
function buildQuery() {
  const q = new URLSearchParams()

  // só envia filtros com valor
  Object.entries({
    cnaePrincipal: filters.cnaePrincipal,
    buscarCnaeSecundario: filters.buscarCnaeSecundario ? '1' : '',
    localizacao: filters.localizacao,
    situacao: filters.situacao,
    tipo: filters.tipo,
    naturezaJuridica: filters.naturezaJuridica,
    porte: filters.porte,
    capitalSocial: filters.capitalSocial,
    opcaoMei: filters.opcaoMei,
    opcaoSimples: filters.opcaoSimples,
    tributacao: filters.tributacao,
  }).forEach(([k, v]) => {
    if (v !== '' && v != null) q.set(k, String(v))
  })

  q.set('page', String(page.value))
  q.set('pageSize', String(pageSize))
  return q
}

// chamada de API (troque a URL pela sua)
async function fetchCompaniesImmediate() {
  error.value = ''
  loading.value = true

  // cancela requisição anterior se ainda estiver em voo
  if (aborter) aborter.abort()
  aborter = new AbortController()

  try {
    // EXEMPLO com fetch — adapte para axios se preferir
    const url = `/api/empresas?${buildQuery().toString()}`
    const res = await fetch(url, { signal: aborter.signal })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // formato esperado: { items: [...], total: number }
    const data = await res.json()

    results.value = data.items ?? []
    total.value = Number.isFinite(data.total) ? data.total : results.value.length
  } catch (e) {
    if (e?.name === 'AbortError') return // foi cancelado, ignora
    error.value = e?.message ?? 'Erro ao buscar dados'
    results.value = []
  } finally {
    loading.value = false
  }
}

// versão com debounce
const fetchCompanies = debounce(fetchCompaniesImmediate, 400)

// 🔁 Reagir a mudanças dos filtros e da página
watch(
  () => ({
    // observar cada campo garante reatividade profunda sem custo grande
    cnaePrincipal: filters.cnaePrincipal,
    buscarCnaeSecundario: filters.buscarCnaeSecundario,
    localizacao: filters.localizacao,
    situacao: filters.situacao,
    tipo: filters.tipo,
    naturezaJuridica: filters.naturezaJuridica,
    porte: filters.porte,
    capitalSocial: filters.capitalSocial,
    opcaoMei: filters.opcaoMei,
    opcaoSimples: filters.opcaoSimples,
    tributacao: filters.tributacao,
    page: page.value,
  }),
  (cur, prev) => {
    // se filtro mudou (não apenas página), reseta para a página 1
    if (prev && cur && cur.page === prev.page) page.value = 1
    fetchCompanies()
  },
  { immediate: true }
)

// ações auxiliares
function clearFilters() {
  Object.assign(filters, {
    cnaePrincipal: '',
    buscarCnaeSecundario: true,
    localizacao: '',
    situacao: '',
    tipo: '',
    naturezaJuridica: '',
    porte: '',
    capitalSocial: '',
    opcaoMei: '',
    opcaoSimples: '',
    tributacao: '',
  })
}

function verEmpresa(item) {
  // navegue para a rota ou abra modal
  alert(`Ver empresa: ${item.nome}`)
}

function exportCsv() {
  const header = ['codigo', 'nome', 'status', 'atualizadoEm', 'localidade']
  const lines = results.value.map(r => [r.codigo, r.nome, r.status, r.atualizadoEm, r.localidade])
  const csv = [header, ...lines].map(arr => arr.join(';')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'empresas.csv'
  a.click()
  URL.revokeObjectURL(url)
}

onBeforeUnmount(() => {
  if (aborter) aborter.abort()
})
</script>
