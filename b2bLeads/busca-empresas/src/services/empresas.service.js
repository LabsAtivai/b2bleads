// src/services/empresas.service.js
import qs from 'qs'
import { get } from '@/api' // seu axios factory (baseURL deve apontar para "/api")

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

  // valores padrão úteis
  const defaults = {
    page: 1,
    pageSize: 10,
    // fields: 'cnpj,nome,localidade,codigo,status,atualizado_em', // exemplo (compacta)
    // detalhe: '0',
  }

  // limpa chaves vazias para não poluir a URL
  const params = compact({ ...defaults, ...query })

  const queryString = qs.stringify(params, {
    addQueryPrefix: true,   // já inclui '?'
    encode: false,          // mantém vírgulas/percentual sem double-encoding
    allowDots: true,
    arrayFormat: 'repeat',  // a=1&a=2
  })

  const { data } = await http.get(`${controller}?${queryString}`)
  // data = { items: [...], total: number }
  return data
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

export function toApiParams(form = {}) {
  return compact({
    cnaePrincipal: form.cnaePrincipal,
    buscarCnaeSecundario: form.buscarCnaeSecundario ? '1' : undefined,
    localizacao: form.localizacao,       // 'SP' | '01001000' | '3550308' | 'Sao Paulo'
    situacao: form.situacao,             // 'ATIVA' | 'INATIVA' | ...
    tipo: form.tipo,                     // 'Matriz' | 'Filial' (detalhe=1)
    naturezaJuridica: form.naturezaJuridica,
    porte: form.porte,
    capitalSocial: form.capitalSocial,   // '>=100000' | '10000-50000' etc (se habilitado no back)
    opcaoMei: form.opcaoMei,             // 'S' | 'N' (detalhe=1)
    opcaoSimples: form.opcaoSimples,     // 'S' | 'N' (detalhe=1)
    page: form.page,
    pageSize: form.pageSize,
    fields: form.fields,                 // csv; ex. compacta: 'cnpj,nome,localidade,codigo,status,atualizado_em'
    detalhe: form.detalhe ? '1' : form.detalhe,  // '1' para view completa
  })
}
