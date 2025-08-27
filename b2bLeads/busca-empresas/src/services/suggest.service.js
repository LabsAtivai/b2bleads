// src/services/suggest.service.js
import axios from 'axios'
import qs from 'qs'

// axios isolado, sem interceptors do seu get() global
const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 15000,
  paramsSerializer: p =>
    qs.stringify(p, { arrayFormat: 'repeat', encode: false })
})

// helper para montar querystring quando a rota espera query pura
function buildQS(params = {}) {
  return qs.stringify(params, {
    addQueryPrefix: true,
    encode: false,
    allowDots: false,
    arrayFormat: 'repeat',
  })
}

// Cada função retorna sempre [{ value, label }]
export async function suggestUf(q = '') {
  const { data } = await http.get(`/suggest/uf${buildQS({ q })}`)
  // backend deve retornar array; se vier objeto com erro, cai no array vazio
  const arr = Array.isArray(data) ? data : []
  return arr.map(x => ({ value: x.uf, label: x.uf }))
}

export async function suggestCidade(q = '', uf = '') {
  const { data } = await http.get(`/suggest/cidade${buildQS({ q, uf })}`)
  const arr = Array.isArray(data) ? data : []
  return arr.map(x => ({
    value: x.cidade,
    label: uf ? `${x.cidade} - ${uf}` : x.cidade,
  }))
}

export async function suggestNatureza(q = '') {
  const { data } = await http.get(`/suggest/natureza${buildQS({ q })}`)
  const arr = Array.isArray(data) ? data : []
  return arr.map(x => ({
    value: x.codigo,
    label: `${x.codigo} - ${x.descricao}`,
  }))
}

export async function suggestPorte(q = '') {
  const { data } = await http.get(`/suggest/porte${buildQS({ q })}`)
  const arr = Array.isArray(data) ? data : []
  return arr.map(x => ({ value: x.porte, label: x.porte }))
}

export async function suggestCnae(q = '') {
  const { data } = await http.get(`/suggest/cnae${buildQS({ q })}`)
  const arr = Array.isArray(data) ? data : []
  return arr.map(x => ({
    value: x.codigo,
    label: `${x.codigo} - ${x.descricao}`,
  }))
}

export async function suggestNome(q = '') {
  const { data } = await http.get(`/suggest/nome${buildQS({ q })}`)
  const arr = Array.isArray(data) ? data : []
  return arr.map(x => ({ value: x.nome, label: x.nome }))
}

// Opcional: função genérica
export async function suggest(type, q = '', extra = {}) {
  switch ((type || '').toLowerCase()) {
    case 'uf':        return suggestUf(q)
    case 'cidade':    return suggestCidade(q, extra.uf || '')
    case 'natureza':  return suggestNatureza(q)
    case 'porte':     return suggestPorte(q)
    case 'cnae':      return suggestCnae(q)
    case 'nome':      return suggestNome(q)
    default:          return []
  }
}
