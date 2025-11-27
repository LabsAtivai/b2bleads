<script setup>
import { ref, onMounted } from "vue";
import Typeahead from "@/components/Typeahead.vue";
import { findAllEmpresas, toApiParams } from "@/services/empresas.service";
import { suggestPorte, suggestNatureza, suggestCnae } from "@/services/suggest.service";
import { get } from "@/api"; // ✅ import aqui em cima

const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const nextCursor = ref(null);

const form = ref({
  nome: "",
  nomeFantasia: "",
  cnpj: "",
  cnaePrincipal: "",
  localizacao: "",
  porte: "",
  situacao: "",
  naturezaJuridica: "",
  buscarCnaeSecundario: false,
  pageSize: 10,
});

const fetchData = async (cursor = null) => {
  loading.value = true;
  try {
    const params = toApiParams(form.value);
    if (cursor) params.cursor = cursor;

    const { items, total: tt, pageInfo } = await findAllEmpresas(params);

    rows.value = items.map((doc) => {
      const est = doc.estabelecimentos?.[0] || {};
      const endereco = est.endereco || {};
      return {
        cnpj: est.cnpj || "",
        razaoSocial: doc.razaoSocial || "",
        nomeFantasia: est.nomeFantasia || "",
        localidade: `${endereco?.municipio?.descricao || ""} - ${endereco?.uf || ""}`,
        cnaeCodigo:
          est.cnaeFiscalPrincipal?.codigo ||
          est.cnaeFiscalPrincipalCodigo ||
          "",
        porte: doc.porte?.descricao || doc.porte?.codigo || "",
        status: est.situacaoCadastral || "",
      };
    });

    // ✅ total vindo do backend (countDocuments)
    total.value = typeof tt === "number" ? tt : rows.value.length;
    nextCursor.value = pageInfo?.nextCursor || null;
  } catch (e) {
    console.error("Erro ao buscar empresas:", e);
  } finally {
    loading.value = false;
  }
};

const fetchNow = () => fetchData();

const limpar = () => {
  Object.assign(form.value, {
    nome: "",
    nomeFantasia: "",
    cnpj: "",
    cnaePrincipal: "",
    localizacao: "",
    porte: "",
    situacao: "",
    naturezaJuridica: "",
    buscarCnaeSecundario: false,
  });
  fetchNow();
};

const proximaPagina = () => {
  if (nextCursor.value) fetchData(nextCursor.value);
};

// ===== Exportar XLSX com filtros atuais =====
async function baixarXlsx() {
  try {
    loading.value = true;

    const params = toApiParams(form.value);
    const http = await get();

    const response = await http.get("/empresas/export", {
      responseType: "blob",
      params,
    });

    const blob = new Blob([response.data], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = window.URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", "empresas.xlsx");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  } catch (e) {
    console.error("Erro ao exportar XLSX:", e);
  } finally {
    loading.value = false;
  }
}

onMounted(fetchNow);
</script>

<template>
  <div class="space-y-6">
    <!-- Filtros -->
    <div class="card p-4">
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <input v-model="form.nome" placeholder="Razão Social" class="input" />
        <input v-model="form.nomeFantasia" placeholder="Nome Fantasia" class="input" />
        <input v-model="form.cnpj" placeholder="CNPJ" class="input" />
        <Typeahead
          v-model="form.cnaePrincipal"
          :fetcher="suggestCnae"
          label="CNAE Principal"
          show-value
        />
        <Typeahead
          v-model="form.porte"
          :fetcher="suggestPorte"
          label="Porte"
        />
        <input
          v-model="form.localizacao"
          placeholder="Cidade - UF ou apenas UF"
          class="input"
        />
        <Typeahead
          v-model="form.naturezaJuridica"
          :fetcher="suggestNatureza"
          label="Natureza Jurídica"
        />
        <select v-model="form.situacao" class="select">
          <option value="">Todas</option>
          <option value="ATIVA">Ativa</option>
          <option value="INATIVA">Inativa</option>
          <option value="BAIXADA">Baixada</option>
        </select>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" v-model="form.buscarCnaeSecundario" />
          Incluir CNAEs Secundários
        </label>

        <button class="btn btn-primary" @click="fetchNow" :disabled="loading">
          Buscar
        </button>
        <button class="btn btn-ghost" @click="limpar" :disabled="loading">
          Limpar
        </button>
        <button
          class="btn btn-outline"
          @click="proximaPagina"
          :disabled="!nextCursor || loading"
        >
          Próxima Página
        </button>
        <!-- ✅ agora chama baixarXlsx -->
        <button
          class="btn btn-outline"
          @click="baixarXlsx"
          :disabled="loading"
        >
          Exportar XLSX
        </button>

        <span v-if="!loading" class="ml-4 text-sm text-slate-600">
          Total: {{ total }}
        </span>
        <span v-else class="ml-4 text-sm text-slate-500">Carregando…</span>
      </div>
    </div>

    <!-- Resultados -->
    <div class="card p-0 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="min-w-full whitespace-nowrap">
          <thead class="bg-slate-50 text-left text-sm text-slate-600">
            <tr>
              <th class="px-4 py-2">CNPJ</th>
              <th class="px-4 py-2">Razão Social</th>
              <th class="px-4 py-2">Nome Fantasia</th>
              <th class="px-4 py-2">Localidade</th>
              <th class="px-4 py-2">CNAE</th>
              <th class="px-4 py-2">Porte</th>
              <th class="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 text-sm">
            <tr v-for="it in rows" :key="it.cnpj" class="hover:bg-slate-50">
              <td class="px-4 py-2 font-mono">{{ it.cnpj }}</td>
              <td class="px-4 py-2">{{ it.razaoSocial }}</td>
              <td class="px-4 py-2">{{ it.nomeFantasia }}</td>
              <td class="px-4 py-2">{{ it.localidade }}</td>
              <td class="px-4 py-2">{{ it.cnaeCodigo }}</td>
              <td class="px-4 py-2">{{ it.porte }}</td>
              <td class="px-4 py-2">{{ it.status }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
