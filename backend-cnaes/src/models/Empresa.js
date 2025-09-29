// src/models/Empresa.js
import mongoose from 'mongoose'

const empresaSchema = new mongoose.Schema({
  cnpj: String,
  cnpj_basico: String,
  razao_social: String,
  nome_fantasia: String,
  situacao: String,
  situacao_codigo: String,
  data_abertura: Date,
  natureza_juridica: String,
  natureza_juridica_desc: String,
  matriz_filial: String,
  cnae_principal: String,
  cnae_principal_desc: String,
  cnaes_secundarios: [String],
  tipo_logradouro: String,
  logradouro: String,
  numero: String,
  complemento: String,
  bairro: String,
  cep: String,
  uf: String,
  cidade: String,
  endereco: String,
  telefones: [String],
  emails: [String],
  capital_social: Number,
  porte_codigo: String,
  porte: String,
  opcao_simples: String,
  opcao_mei: String,
  socios: Array,
  localidade: String,
  nome: String,
  codigo: String,
  status: String,
  atualizado_em: Date
}, { collection: 'empresas' }) // nome da coleção no Mongo

export default mongoose.model('Empresa', empresaSchema)
