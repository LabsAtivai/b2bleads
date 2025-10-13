<!-- src/components/SearchCompanies.vue -->
<template>
  <div class="space-y-6">
    <!-- Filtros -->
    <div class="card p-4">
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <!-- CNAE principal (com autocomplete) -->
        <div>
          <label class="block text-sm font-medium text-slate-700">CNAE principal</label>
          <Typeahead v-model="form.cnaePrincipal" placeholder="ex: 6201501 ou digite para buscar" :minChars="2"
            :fetcher="suggestCnae" :clearOnSelect="false" class="mt-1" />
          <label class="inline-flex items-center gap-2 mt-2 text-sm">
            <input type="checkbox" v-model="form.buscarCnaeSecundario" class="checkbox" />
            Buscar também em CNAEs secundários
          </label>
        </div>

        <!-- Localização (UF / Cidade / CEP / IBGE) -->
        <div>
          <label class="block text-sm font-medium text-slate-700">Localização</label>
          <div class="flex gap-2 mt-1">
            <Typeahead v-model="quickUf" placeholder="UF (ex: SP)" :minChars="1" :fetcher="suggestUf" class="flex-1" />
            <button class="btn btn-outline" @click="aplicarUf()" :disabled="!quickUf">Aplicar</button>
          </div>
          <Typeahead v-model="form.localizacao" placeholder="Cidade (ex: Sao Paulo)" :minChars="2"
            :fetcher="fetchCidade" class="mt-2" />
          <p class="text-xs text-slate-500 mt-1">
            Você também pode digitar CEP (8 dígitos) ou código IBGE (7) diretamente.
          </p>
        </div>

        <!-- Situação -->
        <div>
          <label class="block text-sm font-medium text-slate-700">Situação</label>
          <select v-model="form.situacao" class="select mt-1">
            <option value="">(Padrão: ATIVA)</option>
            <option value="ATIVA">ATIVA</option>
            <option value="INATIVA">INATIVA</option>
            <option value="NULA">NULA</option>
            <option value="SUSPENSA">SUSPENSA</option>
            <option value="INAPTA">INAPTA</option>
            <option value="BAIXADA">BAIXADA</option>
          </select>
        </div>

        <!-- Modo detalhe -->
        <div>
          <label class="block text-sm font-medium text-slate-700">Detalhe</label>
          <select v-model="form.detalhe" class="select mt-1">
            <option :value="false">Compacto</option>
            <option :value="true">Completo</option>
          </select>
          <p class="text-xs text-slate-500 mt-2">
            Completo habilita filtros/colunas extras (porte, natureza, sócios, etc).
          </p>
        </div>

        <!-- Porte (somente detalhe=1) -->
        <div v-if="form.detalhe">
          <label class="block text-sm font-medium text-slate-700">Porte</label>
          <Typeahead v-model="form.porte" placeholder="Digite para filtrar portes" :minChars="0" :fetcher="suggestPorte"
            class="mt-1" />
        </div>

        <!-- Tipo (matriz/filial) (somente detalhe=1) -->
        <div v-if="form.detalhe">
          <label class="block text-sm font-medium text-slate-700">Tipo</label>
          <select v-model="form.tipo" class="select mt-1">
            <option value="">Todos</option>
            <option value="Matriz">Matriz</option>
            <option value="Filial">Filial</option>
          </select>
        </div>

        <!-- Natureza Jurídica (somente detalhe=1) -->
        <div v-if="form.detalhe">
          <label class="block text-sm font-medium text-slate-700">Natureza Jurídica</label>
          <Typeahead v-model="form.naturezaJuridica" placeholder="Digite para buscar natureza" :minChars="2"
            :fetcher="suggestNatureza" class="mt-1" />
        </div>

        <!-- Simples/MEI (somente detalhe=1) -->
        <div v-if="form.detalhe">
          <label class="block text-sm font-medium text-slate-700">Simples</label>
          <select v-model="form.opcaoSimples" class="select mt-1">
            <option value="">Todos</option>
            <option value="S">Sim</option>
            <option value="N">Não</option>
          </select>
        </div>
        <div v-if="form.detalhe">
          <label class="block text-sm font-medium text-slate-700">MEI</label>
          <select v-model="form.opcaoMei" class="select mt-1">
            <option value="">Todos</option>
            <option value="S">Sim</option>
            <option value="N">Não</option>
          </select>
        </div>

        <!-- Campos -->
        <div class="sm:col-span-2 lg:col-span-2">
          <label class="block text-sm font-medium text-slate-700">Campos</label>
          <input v-model="form.fields" class="input mt-1"
            :placeholder="form.detalhe ? 'Ex: cnpj,razao_social,nome_fantasia,localidade,cnae_principal,porte,atualizado_em' : 'Ex: cnpj,nome,localidade,codigo,status,atualizado_em'" />
          <p class="text-xs text-slate-500 mt-1">
            Deixe em branco para usar os padrões do backend. Use os nomes do mapa de campos da view escolhida.
          </p>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <button class="btn btn-primary" @click="fetchNow" :disabled="loading">Buscar</button>
        <button class="btn btn-ghost" @click="limpar()">Limpar</button>
        <button class="btn btn-outline" @click="baixarCsv" :disabled="loading">
          Exportar CSV (cnpj,nome,localidade,emails)
        </button>
        <span class="text-sm text-slate-600" v-if="!loading">Total: <strong>{{ total }}</strong></span>
        <span class="text-sm text-slate-500" v-else>Carregando…</span>
      </div>
    </div>

    <!-- Facetas simples (a partir dos itens da página) -->
    <div class="card p-4">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <div class="text-sm font-medium text-slate-700 mb-1">UF (nos resultados)</div>
          <div class="flex flex-wrap gap-2">
            <button v-for="uf in facetUf" :key="uf" class="btn btn-outline" @click="aplicarFacetaUf(uf)">
              {{ uf }}
            </button>
          </div>
        </div>
        <div class="sm:col-span-2">
          <div class="text-sm font-medium text-slate-700 mb-1">Cidades (nos resultados)</div>
          <div class="flex flex-wrap gap-2 max-h-28 overflow-auto pr-2">
            <button v-for="cid in facetCidade" :key="cid" class="btn btn-outline" @click="aplicarFacetaCidade(cid)">
              {{ cid }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Tabela -->
    <div class="card p-0 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="min-w-full whitespace-nowrap">
          <thead class="bg-slate-50 text-left text-sm text-slate-600">
            <tr>
              <th class="px-4 py-2">CNPJ</th>
              <th class="px-4 py-2">Nome</th>
              <th class="px-4 py-2">Localidade</th>
              <th class="px-4 py-2">CNAE</th>
              <th class="px-4 py-2">Status</th>
              <th class="px-4 py-2">Atualizado</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 text-sm">
            <tr v-for="it in rows" :key="it.cnpj" class="hover:bg-slate-50">
              <td class="px-4 py-2 font-mono">{{ it.estabelecimentos[0].cnpj }}</td>
              <td class="px-4 py-2">{{ it.nome || it.nome_fantasia || it.razaoSocial }}</td>
              <td class="px-4 py-2">{{ it.estabelecimentos[0].endereco.tipoLogradouro }} {{
                it.estabelecimentos[0].endereco.logradouro }}, {{
                  it.estabelecimentos[0].endereco.numero }} - {{ it.estabelecimentos[0].endereco.bairro }} - {{
                  it.estabelecimentos[0].endereco.municipio.descricao }} - {{ it.estabelecimentos[0].endereco.uf }} ({{
                  it.estabelecimentos[0].endereco.cep }})</td>
              <td class="px-4 py-2">{{ it.estabelecimentos[0].cnaeFiscalPrincipal.codigo }}</td>
              <td class="px-4 py-2">{{ it.estabelecimentos[0].motivoSituacaoCadastral.descricao }}</td>
              <td class="px-4 py-2">{{ it.updatedAt }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Paginação -->
      <div class="flex items-center justify-between px-4 py-3">
        <div class="text-sm text-slate-600">
          Página {{ form.page }} de {{ totalPages }}
        </div>
        <div class="flex gap-2">
          <button class="btn btn-outline" :disabled="form.page <= 1 || loading"
            @click="goPage(form.page - 1)">Anterior</button>
          <button class="btn btn-outline" :disabled="form.page >= totalPages || loading"
            @click="goPage(form.page + 1)">Próxima</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'

// serviços
import { findAllEmpresas, toApiParams } from '@/services/empresas.service'
import {
  suggestCnae,
  suggestUf,
  suggestCidade,
  suggestNatureza,
  suggestPorte,
} from '@/services/suggest.service'

// componente de autocomplete
import Typeahead from '@/components/Typeahead.vue'

// ---------- estado ----------
const rows = ref([])
const total = ref(0)
const loading = ref(false)

// filtros do formulário
const form = ref({
  cnaePrincipal: '',
  buscarCnaeSecundario: false,
  localizacao: '',
  situacao: '',       // backend pode assumir ATIVA quando vazio (se ativar na API)
  tipo: '',
  naturezaJuridica: '',
  porte: '',
  capitalSocial: '',
  opcaoMei: '',
  opcaoSimples: '',
  detalhe: false,     // false = compacta; true = completa
  fields: 'cnpj,nome,localidade,codigo,status,atualizado_em',
  page: 1,
  pageSize: 10,
})

// UF “rápida” (para preencher o campo de localização)
const quickUf = ref('')

// ---------- helpers ----------
function debounce(fn, ms = 400) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / form.value.pageSize)))

// Facetas simples com base na página atual
const facetUf = computed(() => {
  const s = new Set()
  for (const r of rows.value) if (r.uf) s.add(r.uf)
  return [...s].sort()
})
const facetCidade = computed(() => {
  const s = new Set()
  for (const r of rows.value) {
    const c = r.cidade || (r.localidade ? String(r.localidade).split(' - ')[0] : '')
    if (c) s.add(c)
  }
  return [...s].sort()
})

// aplicar facetas
function aplicarFacetaUf(uf) {
  form.value.localizacao = uf
}
function aplicarFacetaCidade(cid) {
  form.value.localizacao = cid
}
function aplicarUf() {
  if (quickUf.value) {
    form.value.localizacao = quickUf.value
    quickUf.value = ''
  }
}

// limpar filtros
function limpar() {
  form.value = {
    cnaePrincipal: '',
    buscarCnaeSecundario: false,
    localizacao: '',
    situacao: '',
    tipo: '',
    naturezaJuridica: '',
    porte: '',
    capitalSocial: '',
    opcaoMei: '',
    opcaoSimples: '',
    detalhe: false,
    fields: 'cnpj,nome,localidade,codigo,status,atualizado_em',
    page: 1,
    pageSize: 10,
  }
}

// montar params pra API
const buildParams = () => {
  // quando detalhe=1 e fields vazio, sugere um conjunto mais rico
  let fields = form.value.fields
  if (form.value.detalhe && (!fields || !fields.trim())) {
    fields = 'cnpj,razao_social,nome_fantasia,localidade,cnae_principal,porte,atualizado_em'
  }
  return toApiParams({
    ...form.value,
    detalhe: form.value.detalhe, // toApiParams converte para '0'/'1'
    fields,
  })
}

// sugestões que dependem de outros campos
const fetchCidade = async (q) => {
  const uf = /^[A-Za-z]{2}$/.test(form.value.localizacao) ? form.value.localizacao : ''
  return suggestCidade(q, uf)
}

// chamada à API (com proteção de corrida)
let lastCallId = 0
const fetchData = async () => {
  const callId = ++lastCallId
  loading.value = true
  try {
    const params = buildParams()
    const { items, total: tt } = await findAllEmpresas(params)
    if (callId !== lastCallId) return // descarta respostas antigas
    rows.value = items
    total.value = tt

    console.log(rows.value);
  } catch (e) {
    console.error('Falha ao carregar', e)
  } finally {
    if (callId === lastCallId) loading.value = false
  }
}
const fetchNow = () => fetchData()
const fetchDebounced = debounce(fetchData, 500)

// paginação
function goPage(p) {
  form.value.page = Math.min(Math.max(1, p), totalPages.value)
}

// reagir às mudanças (se filtros mudarem, volta pra página 1)
watch(
  form,
  (nv, ov) => {
    if (nv.page === ov?.page && nv.pageSize === ov?.pageSize) {
      form.value.page = 1
    }
    fetchDebounced()
  },
  { deep: true }
)

onMounted(() => {
  fetchNow()
})

/**
 * Exportar CSV (cnpj, nome, localidade, emails)
 * Envia os mesmos filtros atuais para /api/empresas/export,
 * mas força detalhe=1 e os campos necessários.
 */
function baixarCsv() {
  // monta params a partir do form
  const params = toApiParams({
    ...form.value,
    detalhe: true, // garantir que a view completa seja usada (tem 'emails')
  })

  // troca os campos para os desejados no CSV
  params.fields = 'cnpj,nome,localidade,emails'

  // cria querystring
  const usp = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      usp.append(k, v)
    }
  })

  // abre rota de export (backend deve responder com CSV)
  const url = `/api/empresas/export?${usp.toString()}`
  const a = document.createElement('a')
  a.href = url
  a.setAttribute('download', 'empresas.csv') // alguns browsers ignoram; header do servidor prevalece
  document.body.appendChild(a)
  a.click()
  a.remove()
}
</script>
