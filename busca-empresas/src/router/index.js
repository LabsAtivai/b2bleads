import { createRouter, createWebHistory } from 'vue-router'
import SearchCompanies from '@/components/SearchCompanies.vue' // ajuste o caminho

const routes = [
  { path: '/', name: 'home', component: SearchCompanies },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
