import mongoose from 'mongoose';

const empresaSchema = new mongoose.Schema({
  cnpjBasico: { type: String, index: true, unique: true },
  capitalSocial: Number,
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
  enteFederativoResponsavel: String,

  razaoSocial: String,
  simples: String,

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

  socios: Array,

  estabelecimentos: [
    {
      cnpj: String,
      cnpjBasico: String,
      cnaeFiscalPrincipalCodigo: String,
      cnaeFiscalPrincipal: {
        codigo: String,
        descricao: String,
      },
      cnaesSecundariosCodigos: [String],
      contatos: {
        ddd1: String,
        telefone1: String,
        ddd2: String,
        telefone2: String,
        dddFax: String,
        fax: String,
        email: String,
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
        municipio: {
          codigo: String,
          descricao: String,
        },
      },
      identificadorMatrizFilial: String,
      motivoSituacaoCadastralCodigo: String,
      motivoSituacaoCadastral: {
        codigo: String,
        descricao: String,
      },
      nomeCidadeExterior: String,
      nomeFantasia: String,
      paisCodigo: String,
      situacaoCadastral: String,
      situacaoEspecial: String,
    },
  ],
}, {
  collection: 'empresas_agg',
  versionKey: false,
});

// Índices principais
empresaSchema.index({ cnpjBasico: 1 }, { name: 'ux_cnpj_basico', unique: true });
empresaSchema.index({ updatedAt: -1, _id: -1 }, { name: 'ord_updated__id' });

empresaSchema.index({ 'porte.codigo': 1, updatedAt: -1 }, { name: 'porte_cod_ord' });
empresaSchema.index({ 'natureza.codigo': 1, updatedAt: -1 }, { name: 'nat_cod_ord' });

empresaSchema.index({ 'estabelecimentos.cnaeFiscalPrincipalCodigo': 1, updatedAt: -1 }, { name: 'estab_cnae_princ_ord' });
empresaSchema.index({ 'estabelecimentos.cnaesSecundariosCodigos': 1, updatedAt: -1 }, { name: 'estab_cnae_sec_ord' });

empresaSchema.index({ 'estabelecimentos.endereco.uf': 1, updatedAt: -1 }, { name: 'loc_uf_ord' });
empresaSchema.index({ 'estabelecimentos.endereco.municipio.descricao': 1, updatedAt: -1 }, { name: 'loc_cidade_ord' });
empresaSchema.index({ 'estabelecimentos.endereco.cep': 1, updatedAt: -1 }, { name: 'loc_cep_ord' });

empresaSchema.index({ razaoSocial: 'text', 'estabelecimentos.nomeFantasia': 'text' }, { name: 'txt_razao_fantasia' });

export default mongoose.model('Empresa', empresaSchema);
