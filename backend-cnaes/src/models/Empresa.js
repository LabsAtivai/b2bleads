// src/models/Empresa.js
import mongoose from 'mongoose'

const empresaSchema = new mongoose.Schema(
  {
    cnpj: String,
    cnpj_basico: String,
    razao_social: String,
    nome_fantasia: String,

    situacao: String,
    situacao_codigo: String, // '2' = ATIVA

    data_abertura: Date,

    natureza_juridica: String,
    natureza_juridica_desc: String,

    matriz_filial: String, // 'Matriz' | 'Filial'

    // CNAE principal (e, em alguns datasets, "codigo" também é usado)
    cnae_principal: String,
    cnae_principal_desc: String,
    codigo: String, // sinônimo em alguns lugares da sua API

    // Secundários (array -> multikey)
    cnaes_secundarios: [String],

    // (Opcional, recomendação de performance)
    // cnae_all: [String], // principal, codigo e todos os secundários (se usar, crie índice abaixo e remova $or da consulta)

    tipo_logradouro: String,
    logradouro: String,
    numero: String,
    complemento: String,
    bairro: String,
    cep: String,

    uf: String,
    cidade: String, // se parseLocalizacao usar "municipio", alinhar aqui
    municipio_codigo: String, // opcional: IBGE (se você já usa no filtro)

    endereco: String,

    telefones: [String],
    emails: [String],

    capital_social: Number, // range-friendly

    porte_codigo: String,
    porte: String,

    opcao_simples: String, // 'S' | 'N'
    opcao_mei: String,     // 'S' | 'N'

    socios: Array,

    localidade: String,
    nome: String,

    status: String,

    // usado no sort e cursor
    atualizado_em: Date,
  },
  {
    collection: 'empresas',
    versionKey: false,
  }
)

/**
 * ÍNDICES — nomes padronizados para usar com hint() do lado da API
 * Regra: filtros de igualdade primeiro, depois ordenação { atualizado_em:-1, _id:-1 } para casar com o sort.
 */

// detalhe por CNPJ
empresaSchema.index({ cnpj: 1 }, { unique: true, name: 'ux_cnpj' })

// ordenação base para keyset
empresaSchema.index({ atualizado_em: -1, _id: -1 }, { name: 'ord_atualizado__id' })

// filtros comuns + ordenação
empresaSchema.index({ situacao_codigo: 1, atualizado_em: -1, _id: -1 }, { name: 'sit_ord' })
empresaSchema.index({ matriz_filial: 1, atualizado_em: -1, _id: -1 }, { name: 'tipo_ord' })
empresaSchema.index({ natureza_juridica: 1, atualizado_em: -1, _id: -1 }, { name: 'nat_ord' })
empresaSchema.index({ porte: 1, atualizado_em: -1, _id: -1 }, { name: 'porte_ord' })
empresaSchema.index({ opcao_mei: 1, atualizado_em: -1, _id: -1 }, { name: 'mei_ord' })
empresaSchema.index({ opcao_simples: 1, atualizado_em: -1, _id: -1 }, { name: 'simples_ord' })

// cnae principal (e "codigo" se você ainda filtra por ele)
empresaSchema.index({ cnae_principal: 1, atualizado_em: -1, _id: -1 }, { name: 'cnae_princ_ord' })
empresaSchema.index({ codigo: 1, atualizado_em: -1, _id: -1 }, { name: 'codigo_princ_ord' })

// cnaes secundários (multikey)
empresaSchema.index({ cnaes_secundarios: 1, atualizado_em: -1, _id: -1 }, { name: 'cnae_sec_ord' })

// localização (alinhe com parseLocalizacao)
empresaSchema.index({ uf: 1, municipio_codigo: 1, atualizado_em: -1, _id: -1 }, { name: 'loc_ord' })
// fallback se você não usa municipio_codigo: uf/cidade/cep
empresaSchema.index({ uf: 1, cidade: 1, cep: 1, atualizado_em: -1, _id: -1 }, { name: 'loc_fallback_ord' })

// capital social (ranges)
empresaSchema.index({ capital_social: 1, atualizado_em: -1, _id: -1 }, { name: 'capital_ord' })

// (Opcional) Index se você denormalizar cnae_all
// empresaSchema.index({ cnae_all: 1, atualizado_em: -1, _id: -1 }, { name: 'cnae_all_ord' })

export default mongoose.model('Empresa', empresaSchema)
