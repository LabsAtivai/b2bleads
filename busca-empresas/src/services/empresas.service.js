// src/services/empresas.service.js
import qs from 'qs'
import { get } from '@/api' // axios factory com baseURL apontando para "/api"

const controller = 'empresas'

function compact(obj = {}) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    out[k] = v
  }
  return out
}

export async function findAllEmpresas(query = {}) {
  const http = await get()

  const defaults = {
    page: 1,
    pageSize:10,
    // fields: 'cnpj,nome,localidade,codigo,status,atualizado_em',
    // detalhe: '0',
  }

  const params = compact({ ...defaults, ...query })
  const queryString = qs.stringify(params, {
    addQueryPrefix: true,
    encode: false,
    allowDots: true,
    arrayFormat: 'repeat',
  })

  const { data } = await http.get(`${controller}?${queryString}`)
  return data // { items, total }
}

export async function findEmpresaByCnpj(cnpj) {
  const http = await get()
  const clean = String(cnpj || '').replace(/\D/g, '')
  if (!/^\d{14}$/.test(clean)) {
    throw new Error('CNPJ inválido: envie 14 dígitos')
  }
  const { data } = await http.get(`${controller}/${clean}`)
  return data
}


// src/services/empresas.service.js
export function toApiParams(form = {}) {
  return compact({
    nome: form.nome,
    nomeFantasia: form.nomeFantasia,
    cnpj: form.cnpj,
    cnaePrincipal: form.cnaePrincipal,
    buscarCnaeSecundario: form.buscarCnaeSecundario ? '1' : undefined,
    localizacao: form.localizacao,
    uf: form.uf,
    cidade: form.cidade,
    cep: form.cep,
    situacao: form.situacao,
    naturezaJuridica: form.naturezaJuridica,
    porte: form.porte,
    capitalSocial: form.capitalSocial,
    email: form.email,
    temEmail: form.temEmail ? '1' : undefined,
    temTelefone: form.temTelefone ? '1' : undefined,
    telefone: form.telefone,
    simplesNacional: form.simplesNacional,
    dataAberturaMin: form.dataAberturaMin ? form.dataAberturaMin.replace(/-/g, '') : undefined,
    dataAberturaMax: form.dataAberturaMax ? form.dataAberturaMax.replace(/-/g, '') : undefined,
    pageSize: form.pageSize,
    cursor: form.cursor,
  })
}



export async function exportEmpresasCsv() {
  const http = await get()
  const response = await http.get('/empresas/export', {
    responseType: 'blob' // importante para baixar arquivo
  })

  // cria link temporário para download
  const url = window.URL.createObjectURL(new Blob([response.data]))
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', 'BaseB2B.csv')
  document.body.appendChild(link)
  link.click()
  link.remove()
}
