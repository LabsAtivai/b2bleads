<script setup>
import { ref, computed, onMounted } from "vue";
import Typeahead from "@/components/Typeahead.vue";
import { findAllEmpresas, toApiParams } from "@/services/empresas.service";
import { suggestPorte, suggestNatureza, suggestCnae, suggestCidade } from "@/services/suggest.service";
import { get } from "@/api";

const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const nextCursor = ref(null);
const cursorHistory = ref([]);
const currentPage = ref(1);
const errorMsg = ref(null);
const exportStatus = ref("idle");
const showAdvanced = ref(false);

const UFS = ["AC","AL","AM","AP","BA","CE","DF","ES","GO","MA","MG","MS","MT","PA","PB","PE","PI","PR","RJ","RN","RO","RR","RS","SC","SE","SP","TO"];

const defaultForm = {
  nome: "", nomeFantasia: "", cnpj: "", cnaePrincipal: "",
  uf: "", cidade: "", cep: "",
  porte: "", situacao: "", naturezaJuridica: "",
  buscarCnaeSecundario: false,
  email: "", temEmail: false, temTelefone: false, telefone: "",
  capitalSocial: "", simplesNacional: "",
  dataAberturaMin: "", dataAberturaMax: "",
  pageSize: 10,
};

const form = ref({ ...defaultForm });

async function suggestCidadePorUf(q = "") {
  if (!q || q.length < 2) return [];
  return suggestCidade(q, form.value.uf || "");
}

const SITUACAO_MAP = {
  "02": "Ativa", "01": "Nula", "03": "Suspensa",
  "04": "Inapta", "08": "Baixada", "09": "Cancelada",
};

const activeFilters = computed(() => {
  const tags = [];
  const f = form.value;
  if (f.nome) tags.push({ key: "nome", label: f.nome, group: "Razão" });
  if (f.nomeFantasia) tags.push({ key: "nomeFantasia", label: f.nomeFantasia, group: "Fantasia" });
  if (f.cnpj) tags.push({ key: "cnpj", label: f.cnpj, group: "CNPJ" });
  if (f.cnaePrincipal) tags.push({ key: "cnaePrincipal", label: f.cnaePrincipal, group: "CNAE" });
  if (f.uf) tags.push({ key: "uf", label: f.uf, group: "UF" });
  if (f.cidade) tags.push({ key: "cidade", label: f.cidade, group: "Cidade" });
  if (f.cep) tags.push({ key: "cep", label: f.cep, group: "CEP" });
  if (f.porte) tags.push({ key: "porte", label: f.porte, group: "Porte" });
  if (f.situacao) tags.push({ key: "situacao", label: f.situacao });
  if (f.naturezaJuridica) tags.push({ key: "naturezaJuridica", label: f.naturezaJuridica, group: "Natureza" });
  if (f.email) tags.push({ key: "email", label: f.email, group: "Email" });
  if (f.temEmail) tags.push({ key: "temEmail", label: "Com email" });
  if (f.temTelefone) tags.push({ key: "temTelefone", label: "Com telefone" });
  if (f.telefone) tags.push({ key: "telefone", label: f.telefone, group: "Tel" });
  if (f.capitalSocial) tags.push({ key: "capitalSocial", label: f.capitalSocial, group: "Capital" });
  if (f.simplesNacional) tags.push({ key: "simplesNacional", label: f.simplesNacional });
  if (f.dataAberturaMin) tags.push({ key: "dataAberturaMin", label: f.dataAberturaMin, group: "De" });
  if (f.dataAberturaMax) tags.push({ key: "dataAberturaMax", label: f.dataAberturaMax, group: "Até" });
  if (f.buscarCnaeSecundario) tags.push({ key: "buscarCnaeSecundario", label: "CNAE Secundário" });
  return tags;
});

function removeFilter(key) {
  form.value[key] = typeof defaultForm[key] === "boolean" ? false : "";
  fetchNow();
}

let currentEntryCursor = null;

const fetchData = async (cursor = null) => {
  loading.value = true;
  errorMsg.value = null;
  try {
    const params = toApiParams(form.value);
    if (cursor) params.cursor = cursor;
    const { items, total: tt, pageInfo } = await findAllEmpresas(params);
    rows.value = items.map((doc) => {
      const est = doc.estabelecimentos?.[0] || {};
      const end = est.endereco || {};
      const cont = est.contatos || {};
      return {
        cnpj: est.cnpj || "",
        razaoSocial: doc.razaoSocial || "",
        nomeFantasia: est.nomeFantasia || "",
        localidade: [end.municipio?.descricao, end.uf].filter(Boolean).join(" - "),
        cnaeCodigo: est.cnaeFiscalPrincipal?.codigo || est.cnaeFiscalPrincipalCodigo || "",
        cnaeDescricao: est.cnaeFiscalPrincipal?.descricao || "",
        porte: doc.porte?.descricao || doc.porte?.codigo || "",
        status: est.situacaoCadastral || "",
        email: est.email || cont.email || "",
        telefone: (Array.isArray(est.telefones) && est.telefones[0]) || cont.telefone1 || "",
      };
    });
    total.value = typeof tt === "number" ? tt : rows.value.length;
    nextCursor.value = pageInfo?.nextCursor || null;
  } catch (e) {
    console.error("Erro ao buscar empresas:", e);
    errorMsg.value = "Falha ao buscar. Verifique a conexão e tente novamente.";
    rows.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
};

const fetchNow = () => { cursorHistory.value = []; currentPage.value = 1; currentEntryCursor = null; fetchData(); };
const limpar = () => { Object.assign(form.value, { ...defaultForm }); fetchNow(); };
const proximaPagina = () => { if (!nextCursor.value) return; cursorHistory.value.push(currentEntryCursor); currentEntryCursor = nextCursor.value; currentPage.value++; fetchData(nextCursor.value); };
const paginaAnterior = () => { if (!cursorHistory.value.length) return; currentPage.value--; currentEntryCursor = cursorHistory.value.pop(); fetchData(currentEntryCursor); };

async function baixarXlsx() {
  try {
    exportStatus.value = "loading";
    const params = toApiParams(form.value);
    const http = await get();
    const res = await http.get("/empresas/export", { responseType: "blob", params });
    const url = window.URL.createObjectURL(new Blob([res.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a"); a.href = url; a.download = "empresas.xlsx"; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    exportStatus.value = "done"; setTimeout(() => (exportStatus.value = "idle"), 3000);
  } catch { exportStatus.value = "error"; setTimeout(() => (exportStatus.value = "idle"), 4000); }
}

function formatCnpj(c) {
  if (!c || c.length !== 14) return c;
  return `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5,8)}/${c.slice(8,12)}-${c.slice(12)}`;
}

const totalPages = computed(() => {
  if (!total.value || !form.value.pageSize) return 0;
  return Math.ceil(total.value / form.value.pageSize);
});

const rangeStart = computed(() => {
  return ((currentPage.value - 1) * form.value.pageSize) + 1;
});

const rangeEnd = computed(() => {
  const end = currentPage.value * form.value.pageSize;
  return Math.min(end, total.value);
});

const advancedCount = computed(() => {
  let n = 0;
  const f = form.value;
  if (f.naturezaJuridica) n++; if (f.email) n++; if (f.telefone) n++; if (f.cep) n++;
  if (f.capitalSocial) n++; if (f.simplesNacional) n++; if (f.dataAberturaMin) n++; if (f.dataAberturaMax) n++;
  if (f.temEmail) n++; if (f.temTelefone) n++; if (f.buscarCnaeSecundario) n++;
  return n;
});

onMounted(fetchNow);
</script>

<template>
  <div class="space-y-3">

    <!-- Error -->
    <Transition enter-active-class="transition duration-200" enter-from-class="opacity-0 -translate-y-2" enter-to-class="opacity-100 translate-y-0">
      <div v-if="errorMsg" class="flex items-center justify-between gap-3 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
        <div class="flex items-center gap-2">
          <svg class="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd"/></svg>
          {{ errorMsg }}
        </div>
        <button class="btn btn-ghost text-red-600 text-xs !px-2 !py-1" @click="fetchNow">Tentar novamente</button>
      </div>
    </Transition>

    <!-- Filters Card -->
    <div class="card">
      <div class="p-4 pb-3">
        <!-- Main filters grid -->
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-3 gap-y-2">
          <div class="filter-group">
            <span class="label">Razão Social</span>
            <input v-model="form.nome" placeholder="Nome da empresa" class="input" @keyup.enter="fetchNow" />
          </div>
          <div class="filter-group">
            <span class="label">Nome Fantasia</span>
            <input v-model="form.nomeFantasia" placeholder="Nome fantasia" class="input" @keyup.enter="fetchNow" />
          </div>
          <div class="filter-group">
            <span class="label">CNPJ</span>
            <input v-model="form.cnpj" placeholder="00.000.000/0001-00" class="input" @keyup.enter="fetchNow" />
          </div>
          <Typeahead v-model="form.cnaePrincipal" :fetcher="suggestCnae" label="CNAE" show-value />
          <div class="filter-group">
            <span class="label">UF</span>
            <select v-model="form.uf" class="select" @change="form.cidade = ''">
              <option value="">Todos</option>
              <option v-for="u in UFS" :key="u" :value="u">{{ u }}</option>
            </select>
          </div>
          <Typeahead v-model="form.cidade" :fetcher="suggestCidadePorUf" label="Cidade" placeholder="Digite a cidade" />
        </div>

        <!-- Row 2 -->
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-3 gap-y-2 mt-2">
          <div class="filter-group">
            <span class="label">Situação</span>
            <select v-model="form.situacao" class="select">
              <option value="">Todas</option>
              <option value="ATIVA">Ativa</option>
              <option value="INATIVA">Inativa</option>
              <option value="BAIXADA">Baixada</option>
              <option value="SUSPENSA">Suspensa</option>
              <option value="INAPTA">Inapta</option>
              <option value="NULA">Nula</option>
              <option value="CANCELADA">Cancelada</option>
            </select>
          </div>
          <Typeahead v-model="form.porte" :fetcher="suggestPorte" label="Porte" />
        </div>
      </div>

      <!-- Advanced filters toggle -->
      <div class="border-t border-gray-100">
        <button
          class="w-full px-4 py-2 flex items-center justify-between text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-50/50 transition-colors"
          @click="showAdvanced = !showAdvanced"
        >
          <span class="flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5 transition-transform duration-200" :class="showAdvanced ? 'rotate-90' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
            </svg>
            Filtros avançados
            <span v-if="advancedCount" class="ml-1 bg-blue-100 text-blue-700 rounded-full px-1.5 py-0 text-[10px] font-semibold">{{ advancedCount }}</span>
          </span>
          <span class="text-[10px] text-gray-400">qualidade de lead, capital, datas</span>
        </button>

        <Transition
          enter-active-class="transition-all duration-200 ease-out"
          enter-from-class="max-h-0 opacity-0"
          enter-to-class="max-h-[500px] opacity-100"
          leave-active-class="transition-all duration-150 ease-in"
          leave-from-class="max-h-[500px] opacity-100"
          leave-to-class="max-h-0 opacity-0"
        >
          <div v-show="showAdvanced" class="overflow-hidden">
            <div class="px-4 pb-4 pt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-3 gap-y-2">
              <Typeahead v-model="form.naturezaJuridica" :fetcher="suggestNatureza" label="Natureza Jurídica" />
              <div class="filter-group">
                <span class="label">Email</span>
                <input v-model="form.email" placeholder="Buscar por email" class="input" @keyup.enter="fetchNow" />
              </div>
              <div class="filter-group">
                <span class="label">Telefone</span>
                <input v-model="form.telefone" placeholder="DDD + número" class="input" @keyup.enter="fetchNow" />
              </div>
              <div class="filter-group">
                <span class="label">CEP</span>
                <input v-model="form.cep" placeholder="00000-000" class="input" @keyup.enter="fetchNow" />
              </div>
              <div class="filter-group">
                <span class="label">Capital Social</span>
                <input v-model="form.capitalSocial" placeholder=">100000" class="input" @keyup.enter="fetchNow" />
              </div>
              <div class="filter-group">
                <span class="label">Regime</span>
                <select v-model="form.simplesNacional" class="select">
                  <option value="">Todos</option>
                  <option value="SIMPLES">Simples Nacional</option>
                  <option value="MEI">MEI</option>
                  <option value="NAO">Não optante</option>
                </select>
              </div>
              <div class="filter-group">
                <span class="label">Abertura de</span>
                <input v-model="form.dataAberturaMin" type="date" class="input" />
              </div>
              <div class="filter-group">
                <span class="label">Abertura até</span>
                <input v-model="form.dataAberturaMax" type="date" class="input" />
              </div>

              <!-- Toggles -->
              <div class="col-span-2 sm:col-span-3 lg:col-span-4 flex flex-wrap items-center gap-x-5 gap-y-2 pt-1">
                <label class="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                  <input type="checkbox" v-model="form.temEmail" class="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4" />
                  <span>Somente com email</span>
                </label>
                <label class="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                  <input type="checkbox" v-model="form.temTelefone" class="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4" />
                  <span>Somente com telefone</span>
                </label>
                <label class="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                  <input type="checkbox" v-model="form.buscarCnaeSecundario" class="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4" />
                  <span>Incluir CNAEs secundários</span>
                </label>
              </div>
            </div>
          </div>
        </Transition>
      </div>

      <!-- Actions bar -->
      <div class="border-t border-gray-100 px-4 py-3 flex flex-wrap items-center gap-2 bg-gray-50/50 rounded-b-xl">
        <button class="btn btn-primary" @click="fetchNow" :disabled="loading">
          <svg v-if="loading" class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
          <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
          {{ loading ? "Buscando..." : "Buscar" }}
        </button>
        <button class="btn btn-ghost text-xs" @click="limpar" :disabled="loading">Limpar tudo</button>

        <div class="hidden sm:block h-5 w-px bg-gray-200 mx-1"></div>

        <div class="flex items-center gap-1">
          <button class="btn btn-secondary !px-2.5" @click="paginaAnterior" :disabled="!cursorHistory.length || loading" title="Página anterior">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
          </button>
          <span class="text-xs text-gray-500 px-2 tabular-nums min-w-[80px] text-center">
            {{ currentPage }} / {{ totalPages || '—' }}
          </span>
          <button class="btn btn-secondary !px-2.5" @click="proximaPagina" :disabled="!nextCursor || loading" title="Próxima página">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
          </button>
        </div>

        <div class="hidden sm:block h-5 w-px bg-gray-200 mx-1"></div>

        <button
          class="btn text-xs"
          :class="{
            'btn-secondary': exportStatus === 'idle',
            'btn-ghost': exportStatus === 'loading',
            'bg-emerald-50 text-emerald-700 border border-emerald-200': exportStatus === 'done',
            'bg-red-50 text-red-700 border border-red-200': exportStatus === 'error',
          }"
          @click="baixarXlsx"
          :disabled="exportStatus === 'loading' || loading"
        >
          <svg v-if="exportStatus === 'loading'" class="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
          <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          {{ { idle: "Exportar", loading: "Gerando...", done: "Baixado!", error: "Erro" }[exportStatus] }}
        </button>

        <div class="flex-1"></div>

        <div v-if="!loading && total > 0" class="flex items-center gap-2 text-xs tabular-nums">
          <span class="text-gray-400">
            {{ rangeStart }}–{{ rangeEnd }} de
          </span>
          <span class="font-semibold text-gray-700">{{ total.toLocaleString("pt-BR") }}</span>
          <span class="text-gray-400">empresa{{ total !== 1 ? "s" : "" }}</span>
        </div>
        <span v-else-if="loading" class="text-xs text-gray-400 animate-pulse">Buscando...</span>
      </div>
    </div>

    <!-- Active filter tags -->
    <Transition enter-active-class="transition duration-200" enter-from-class="opacity-0" enter-to-class="opacity-100">
      <div v-if="activeFilters.length" class="flex flex-wrap gap-1.5">
        <TransitionGroup
          enter-active-class="transition duration-150"
          enter-from-class="opacity-0 scale-90"
          enter-to-class="opacity-100 scale-100"
          leave-active-class="transition duration-100"
          leave-from-class="opacity-100 scale-100"
          leave-to-class="opacity-0 scale-90"
        >
          <span
            v-for="tag in activeFilters"
            :key="tag.key"
            class="inline-flex items-center gap-1 rounded-md pl-2 pr-1 py-0.5 text-xs bg-blue-50 text-blue-700 border border-blue-200/60 group"
          >
            <span v-if="tag.group" class="text-blue-400 font-medium">{{ tag.group }}:</span>
            <span class="font-medium">{{ tag.label }}</span>
            <button @click="removeFilter(tag.key)" class="ml-0.5 p-0.5 rounded hover:bg-blue-200/50 transition-colors">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </span>
        </TransitionGroup>
      </div>
    </Transition>

    <!-- Results table -->
    <div class="card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm transition-opacity duration-200" :style="loading && rows.length ? 'opacity: 0.4; pointer-events: none' : ''">
          <thead>
            <tr class="border-b border-gray-200 bg-gray-50/80">
              <th class="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">CNPJ</th>
              <th class="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Razão Social</th>
              <th class="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden lg:table-cell">Fantasia</th>
              <th class="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Local</th>
              <th class="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">CNAE</th>
              <th class="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden xl:table-cell">Email</th>
              <th class="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden xl:table-cell">Telefone</th>
              <th class="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-20">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <!-- Skeleton -->
            <template v-if="loading && !rows.length">
              <tr v-for="n in 8" :key="'sk-' + n">
                <td class="px-4 py-3" v-for="c in 8" :key="c"><div class="h-3 bg-gray-200 rounded animate-pulse" :style="`width: ${40 + Math.random()*60}%`"></div></td>
              </tr>
            </template>

            <!-- Data rows -->
            <tr v-else v-for="it in rows" :key="it.cnpj" class="hover:bg-blue-50/30 transition-colors">
              <td class="px-4 py-2.5 font-mono text-xs text-gray-600 whitespace-nowrap">{{ formatCnpj(it.cnpj) }}</td>
              <td class="px-4 py-2.5 font-medium text-gray-900 max-w-[250px] truncate" :title="it.razaoSocial">{{ it.razaoSocial }}</td>
              <td class="px-4 py-2.5 text-gray-500 max-w-[200px] truncate hidden lg:table-cell" :title="it.nomeFantasia">{{ it.nomeFantasia || "—" }}</td>
              <td class="px-4 py-2.5 text-gray-600 whitespace-nowrap">{{ it.localidade || "—" }}</td>
              <td class="px-4 py-2.5 hidden md:table-cell">
                <span class="font-mono text-xs text-gray-500" :title="it.cnaeDescricao">{{ it.cnaeCodigo || "—" }}</span>
              </td>
              <td class="px-4 py-2.5 text-xs text-gray-500 max-w-[180px] truncate hidden xl:table-cell" :title="it.email">{{ it.email || "—" }}</td>
              <td class="px-4 py-2.5 font-mono text-xs text-gray-500 hidden xl:table-cell">{{ it.telefone || "—" }}</td>
              <td class="px-4 py-2.5">
                <span
                  class="badge"
                  :class="{
                    'bg-emerald-50 text-emerald-700': it.status === '02',
                    'bg-amber-50 text-amber-700': it.status === '03',
                    'bg-red-50 text-red-600': ['01','04','08','09'].includes(it.status),
                    'bg-gray-100 text-gray-500': !['02','01','03','04','08','09'].includes(it.status),
                  }"
                >
                  <span class="w-1.5 h-1.5 rounded-full" :class="{
                    'bg-emerald-500': it.status === '02',
                    'bg-amber-500': it.status === '03',
                    'bg-red-400': ['01','04','08','09'].includes(it.status),
                    'bg-gray-400': !['02','01','03','04','08','09'].includes(it.status),
                  }"></span>
                  {{ SITUACAO_MAP[it.status] || it.status || '—' }}
                </span>
              </td>
            </tr>

            <!-- Empty state -->
            <tr v-if="!loading && !rows.length && !errorMsg">
              <td colspan="8" class="px-4 py-16 text-center">
                <svg class="mx-auto h-10 w-10 text-gray-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                <p class="text-sm text-gray-500">Nenhuma empresa encontrada</p>
                <p class="text-xs text-gray-400 mt-1">Ajuste os filtros e tente novamente</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
