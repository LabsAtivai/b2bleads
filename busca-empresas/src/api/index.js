// src/api/index.js
// const axios = require('axios')
import axios from 'axios'

const baseURL =
  (import.meta.env.VITE_API_BASE_URL
    ? `${import.meta.env.VITE_API_BASE_URL.replace(/\/+$/, '')}/api`
    : '/api')

const http = axios.create({
  baseURL,
  timeout: 900000,
})

// ===== Auth opcional (sem depender de Pinia aqui)
let authToken = null

export function setAuthToken(token) {
  authToken = token || null
}

http.interceptors.request.use((config) => {
  if (authToken) {
    config.headers = config.headers || {}
    config.headers.Authorization = `Bearer ${authToken}`
  }
  return config
})

// (Opcional) Interceptor de resposta para 401
http.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (err?.response?.status === 401) {
      // Ex.: redirecionar login, limpar token, etc.
      // setAuthToken(null)
      // window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export async function get() {
  return http
}
