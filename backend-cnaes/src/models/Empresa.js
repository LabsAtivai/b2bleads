// src/models/Empresa.js
import mongoose from 'mongoose'

const empresaSchema = new mongoose.Schema(
  {
    cnpj: String,
    cnpj_basico: String,
    razao_social: String,
    nome_fantasia: String,

    situacao: String,
    situacao_codigo: String, // '2' = ATIVA (usado no filtro)

    data_abertura: Date,

    natureza_juridica: String,
    natureza_juridica_desc: String,

    matriz_filial: String, // 'Matriz' | 'Filial'

    // ATENÇÃO: seu filtro usa "codigo" para CNAE principal em alguns pontos da API.
    // Aqui já existem os dois campos; mantenho ambos.
    cnae_principal: String,
    cnae_principal_desc: String,

    cnaes_secundarios: [String], // array -> precisa de índice multikey

    tipo_logradouro: String,
    logradouro: String,
    numero: String,
    complemento: String,
    bairro: String,
    cep: String,

    uf: String,
    cidade: String,       // na API você usou "municipio" em alguns lugares -> alinhar
    endereco: String,

    telefones: [String],
    emails: [String],

    capital_social: Number, // usado em range -> ótimo estar como Number

    porte_codigo: String,
    porte: String,

    opcao_simples: String,  // 'S' | 'N'
    opcao_mei: String,      // 'S' | 'N'

    socios: Array,

    localidade: String, // (se usado em busca, considerar índice depois)
    nome: String,

    // Em alguns datasets isso aparece como sinônimo de CNAE principal.
    // Se você efetivamente usa 'codigo' nos filtros da API, mantenha atualizado aqui.
    codigo: String,

    status: String,

    atualizado_em: Date // usado no sort -> **tem índice**
  },
  {
    collection: 'empresas',
    versionKey: false
  }
)

/**
 * ÍNDICES (desempenho)
 * Regra geral:
 * - Indexar todos os campos do filtro.
 * - Colocar 'atualizado_em' por último em muitos compostos para atender o sort.
 * - Para arrays, índice multikey (Mongo faz automaticamente para campos array).
 */

// detalhe por CNPJ
empresaSchema.index({ cnpj: 1 }, { unique: true })

// ordenação padrão
empresaSchema.index({ atualizado_em: -1 })

// filtros comuns (com sort encadeado)
empresaSchema.index({ situacao_codigo: 1, atualizado_em: -1 })
empresaSchema.index({ matriz_filial: 1, atualizado_em: -1 })
empresaSchema.index({ natureza_juridica: 1, atualizado_em: -1 })
empresaSchema.index({ porte: 1, atualizado_em: -1 })
empresaSchema.index({ opcao_mei: 1, atualizado_em: -1 })
empresaSchema.index({ opcao_simples: 1, atualizado_em: -1 })

// cnae principal (considere padronizar a API para usar cnae_principal)
empresaSchema.index({ cnae_principal: 1, atualizado_em: -1 })
empresaSchema.index({ codigo: 1, atualizado_em: -1 }) // se você realmente usa 'codigo' nos filtros

// cnaes secundários (array -> multikey)
empresaSchema.index({ cnaes_secundarios: 1, atualizado_em: -1 })

// localização: alinhe com o que parseLocalizacao retorna (aqui: uf/cidade/cep)
empresaSchema.index({ uf: 1, cidade: 1, cep: 1, atualizado_em: -1 })

// capital social (se usa range gte/lte)
empresaSchema.index({ capital_social: 1, atualizado_em: -1 })

export default mongoose.model('Empresa', empresaSchema)
