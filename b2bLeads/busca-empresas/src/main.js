import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './assets/tailwind.css'   // garanta que isso existe

createApp(App).use(router).mount('#app')
