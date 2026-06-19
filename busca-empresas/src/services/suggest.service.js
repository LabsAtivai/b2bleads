import { get } from '@/api'
import qs from 'qs'

function buildQS(params = {}) {
  return qs.stringify(params, {
    addQueryPrefix: true,
    encode: false,
    allowDots: false,
    arrayFormat: 'repeat',
  })
}

export async function suggestUf(q = '') {
  const http = await get()
  const { data } = await http.get(`/suggest/uf${buildQS({ q })}`)
  const arr = Array.isArray(data) ? data : []
  return arr.map(x => ({ value: x.value ?? x.uf, label: x.label ?? x.uf }))
}

export async function suggestCidade(q = '', uf = '') {
  const http = await get()
  const { data } = await http.get(`/suggest/cidade${buildQS({ q, uf })}`)
  const arr = Array.isArray(data) ? data : []
  return arr.map(x => ({
    value: x.value ?? `${x.cidade} - ${x.uf}`,
    label: x.label ?? `${x.cidade} - ${x.uf}`,
  }))
}

export async function suggestNatureza(q = '') {
  const http = await get()
  const { data } = await http.get(`/suggest/natureza${buildQS({ q })}`)
  const arr = Array.isArray(data) ? data : []
  return arr.map(x => ({
    value: x.value ?? x.codigo,
    label: x.label ?? `${x.codigo} - ${x.descricao}`,
  }))
}

export async function suggestPorte(q = '') {
  const http = await get()
  const { data } = await http.get(`/suggest/porte${buildQS({ q })}`)
  const arr = Array.isArray(data) ? data : []
  return arr.map(x => ({
    value: x.value,
    label: x.label,
  }))
}

export async function suggestCnae(q = '') {
  const http = await get()
  const { data } = await http.get(`/suggest/cnae${buildQS({ q })}`)
  const arr = Array.isArray(data) ? data : []
  return arr.map(x => ({
    value: x.value ?? x.codigo,
    label: x.label ?? `${x.codigo} - ${x.descricao}`,
  }))
}

export async function suggestNome(q = '') {
  const http = await get()
  const { data } = await http.get(`/suggest/nome${buildQS({ q })}`)
  const arr = Array.isArray(data) ? data : []
  return arr.map(x => ({ value: x.nome, label: x.nome }))
}

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
