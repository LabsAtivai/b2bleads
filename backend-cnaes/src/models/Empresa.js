// src/models/EmpresaAgg.js
import mongoose from 'mongoose'

const empresaSchema = new mongoose.Schema({
  cnpjBasico: { type: String, index: true, unique: true }, // ux_cnpj_basico
  capitalSocial: Number,
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
  enteFederativoResponsavel: String,

  estabelecimentos: [{
    cnpj: String,
    cnaeFiscalPrincipalCodigo: String,
    cnaesSecundariosCodigos: [String],
    cnpjBasico: String,
  }],

  contatos: {
    ddd1: String,
    telefone1: String,
    ddd2: String,
    telefone2: String,
    dddFax: String,
    fax: String,
    email: String,
    createdAt: Date,
  },

  dataInicioAtividade: String,
  dataSituacaoCadastral: String,
  dataSituacaoEspecial: String,

  endereco: {
    tipoLogradouro: String,
    logradouro: String,
    numero: String,
    complemento: String,
    bairro: String,
    cep: String,
    uf: String,
    municipioCodigo: String,
  },

  municipio: {
    codigo: String,
    descricao: String,
    identificadorMatrizFilial: String, // '1' Matriz | '2' Filial (varia por dataset)
    motivoSituacaoCadastralCodigo: String,
    nomeCidadeExterior: String,
    nomeFantasia: String,
    paisCodigo: String,
  },

  situacaoCadastral: String,
  situacaoEspecial: String,

  motivoSituacaoCadastral: {
    codigo: String,
    descricao: String,
  },

  cnaeFiscalPrincipal: {
    codigo: String,
    descricao: String,
  },

  natureza: {
    codigo: String,
    descricao: String,
  },

  porte: {
    codigo: String,
    descricao: String,
  },

  qualificacaoResponsavel: {
    codigo: String,
    descricao: String,
  },

  razaoSocial: String,
  simples: String, // 'S' | 'N' (ou semelhante)

  socios: Array,
}, {
  collection: 'empresas_agg',
  versionKey: false,
})

/**
 * ÍNDICES — convenção de nomes para poder dar hint() nas consultas
 * Regra geral: campos de igualdade primeiro, depois ordenação { updatedAt:-1, _id:-1 }
 */

// Único / detalhe
empresaSchema.index({ cnpjBasico: 1 }, { name: 'ux_cnpj_basico', unique: true })

// Ordenação base para keyset
empresaSchema.index({ updatedAt: -1, _id: -1 }, { name: 'ord_updated__id' })

// Situação cadastral / especial
empresaSchema.index({ situacaoCadastral: 1, updatedAt: -1, _id: -1 }, { name: 'sitcad_ord' })
empresaSchema.index({ situacaoEspecial: 1, updatedAt: -1, _id: -1 }, { name: 'sitesp_ord' })

// Simples
empresaSchema.index({ simples: 1, updatedAt: -1, _id: -1 }, { name: 'simples_ord' })

// Natureza / Porte / Qualificação
empresaSchema.index({ 'natureza.codigo': 1, updatedAt: -1, _id: -1 }, { name: 'nat_cod_ord' })
empresaSchema.index({ 'porte.codigo': 1, updatedAt: -1, _id: -1 }, { name: 'porte_cod_ord' })
empresaSchema.index({ 'qualificacaoResponsavel.codigo': 1, updatedAt: -1, _id: -1 }, { name: 'qualif_cod_ord' })

// CNAE principal (objeto e denormalizado nos estabelecimentos)
empresaSchema.index({ 'cnaeFiscalPrincipal.codigo': 1, updatedAt: -1, _id: -1 }, { name: 'cnae_princ_obj_ord' })
empresaSchema.index({ 'estabelecimentos.cnaeFiscalPrincipalCodigo': 1, updatedAt: -1, _id: -1 }, { name: 'estab_cnae_princ_ord' })

// CNAEs secundários (multikey)
empresaSchema.index({ 'estabelecimentos.cnaesSecundariosCodigos': 1, updatedAt: -1, _id: -1 }, { name: 'estab_cnae_sec_ord' })

// Estabelecimentos — CNPJ (multikey)
empresaSchema.index({ 'estabelecimentos.cnpj': 1, updatedAt: -1, _id: -1 }, { name: 'estab_cnpj_ord' })

// Localização
empresaSchema.index({ 'endereco.uf': 1, 'endereco.municipioCodigo': 1, updatedAt: -1, _id: -1 }, { name: 'loc_uf_mun_ord' })
empresaSchema.index({ 'endereco.cep': 1, updatedAt: -1, _id: -1 }, { name: 'loc_cep_ord' })

// Município (metadados agregados)
empresaSchema.index({ 'municipio.codigo': 1, updatedAt: -1, _id: -1 }, { name: 'mun_cod_ord' })
empresaSchema.index({ 'municipio.identificadorMatrizFilial': 1, updatedAt: -1, _id: -1 }, { name: 'matriz_filial_ord' })
empresaSchema.index({ 'municipio.paisCodigo': 1, updatedAt: -1, _id: -1 }, { name: 'mun_pais_ord' })
empresaSchema.index({ 'municipio.motivoSituacaoCadastralCodigo': 1, updatedAt: -1, _id: -1 }, { name: 'mun_motivo_sitcad_ord' })

// Datas (no dataset estão como String; se puder migrar para Date, melhor)
empresaSchema.index({ dataInicioAtividade: 1, updatedAt: -1, _id: -1 }, { name: 'dt_inicio_ord' })
empresaSchema.index({ dataSituacaoCadastral: 1, updatedAt: -1, _id: -1 }, { name: 'dt_sitcad_ord' })
empresaSchema.index({ dataSituacaoEspecial: 1, updatedAt: -1, _id: -1 }, { name: 'dt_sitesp_ord' })

// Capital social (range)
empresaSchema.index({ capitalSocial: 1, updatedAt: -1, _id: -1 }, { name: 'capital_ord' })

// Contatos (parciais: evitam lixo e gastam menos RAM)
empresaSchema.index(
  { 'contatos.email': 1, updatedAt: -1, _id: -1 },
  { name: 'contato_email_ord', partialFilterExpression: { 'contatos.email': { $type: 'string' } } }
)
empresaSchema.index(
  { 'contatos.telefone1': 1, updatedAt: -1, _id: -1 },
  { name: 'contato_tel1_ord', partialFilterExpression: { 'contatos.telefone1': { $type: 'string' } } }
)
empresaSchema.index(
  { 'contatos.telefone2': 1, updatedAt: -1, _id: -1 },
  { name: 'contato_tel2_ord', partialFilterExpression: { 'contatos.telefone2': { $type: 'string' } } }
)
empresaSchema.index(
  { 'contatos.fax': 1, updatedAt: -1, _id: -1 },
  { name: 'contato_fax_ord', partialFilterExpression: { 'contatos.fax': { $type: 'string' } } }
)

// Busca livre por nome/razão (text index — 1 por coleção)
empresaSchema.index(
  { razaoSocial: 'text', 'municipio.nomeFantasia': 'text' },
  { name: 'txt_razao_fantasia' }
)

// (Opcional) se você costuma filtrar por “enteFederativoResponsavel”
empresaSchema.index({ enteFederativoResponsavel: 1, updatedAt: -1, _id: -1 }, { name: 'ente_fed_resp_ord' })

export default mongoose.model('EmpresaAgg', empresaSchema)
