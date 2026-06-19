<template>
  <div class="min-h-screen bg-gray-50">
    <!-- Header -->
    <header class="bg-white border-b border-gray-200 sticky top-0 z-30">
      <div class="max-w-[1400px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <div>
            <h1 class="text-sm font-semibold text-gray-900 leading-tight">B2B Leads</h1>
            <p class="text-[10px] text-gray-400 font-medium uppercase tracking-wider">AtivaAI</p>
          </div>
        </div>
        <div class="text-xs text-gray-400">Base CNPJ - Receita Federal</div>
      </div>
    </header>

    <!-- Content -->
    <main class="max-w-[1400px] mx-auto px-4 sm:px-6 py-4">
      <SearchCompanies />
    </main>
  </div>
</template>

<script setup>
import SearchCompanies from './components/SearchCompanies.vue'
</script>
