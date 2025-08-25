import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { z } from 'zod'
import { pool } from './db.js'
import { parseLocalizacao, parseCapitalSocial } from './filters.js'

const app = express()
app.use(cors())

// Campos disponíveis em cada view
const FIELD_MAP_COMPACT = {
  cnpj: 'cnpj',
  nome: 'nome',
  localidade: 'localidade',
  codigo: 'codigo',
  status: 'status',
  situacao_codigo: 'situacao_codigo',
  uf: 'uf',
  cidade: 'cidade',
  atualizado_em: "DATE_FORMAT(atualizado_em, '%d/%m/%Y') AS atualizado_em"
}

const FIELD_MAP_FULL = {
  cnpj: 'cnpj',
  cnpj_basico: 'cnpj_basico',
  razao_social: 'razao_social',
  nome_fantasia: 'nome_fantasia',
  situacao: 'situacao',
  situacao_codigo: 'situacao_codigo',
  data_abertura: "DATE_FORMAT(data_abertura, '%d/%m/%Y') AS data_abertura",
  natureza_juridica: 'natureza_juridica',
  natureza_juridica_desc: 'natureza_juridica_desc',
  matriz_filial: 'matriz_filial',
  cnae_principal: 'cnae_principal',
  cnae_principal_desc: 'cnae_principal_desc',
  cnaes_secundarios: 'cnaes_secundarios',
  tipo_logradouro: 'tipo_logradouro',
  logradouro: 'logradouro',
  numero: 'numero',
  complemento: 'complemento',
  bairro: 'bairro',
  cep: 'cep',
  uf: 'uf',
  cidade: 'cidade',
  endereco: 'endereco',
  telefones: 'telefones',
  emails: 'emails',
  capital_social: 'capital_social',
  porte_codigo: 'porte_codigo',
  porte: 'porte',
  opcao_simples: 'opcao_simples',
  opcao_mei: 'opcao_mei',
  socios: 'socios',
  localidade: 'localidade',
  nome: 'nome',
  codigo: 'codigo',
  status: 'status',
  atualizado_em: "DATE_FORMAT(atualizado_em, '%d/%m/%Y') AS atualizado_em"
}

// Validação de query
const SearchSchema = z.object({
  // filtros
  cnaePrincipal: z.string().optional(),
  buscarCnaeSecundario: z.union([z.literal('1'), z.literal('0')]).optional(),
  localizacao: z.string().optional(),
  situacao: z.enum(['ATIVA','INATIVA','NULA','SUSPENSA','INAPTA','BAIXADA'])
             .optional().or(z.string().length(0)),
  tipo: z.enum(['Matriz','Filial']).optional().or(z.string().length(0)),
  naturezaJuridica: z.string().optional(),
  porte: z.enum(['MEI','ME','EPP','DEMAIS','NÃO INFORMADO','EMPRESA DE PEQUENO PORTE'])
         .optional().or(z.string().length(0)),
  capitalSocial: z.string().optional(),
  opcaoMei: z.enum(['S','N']).optional(),
  opcaoSimples: z.enum(['S','N']).optional(),

  // paginação
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(10),

  // seleção de campos
  fields: z.string().optional(),   // csv ou '*'
  detalhe: z.union([z.literal('0'), z.literal('1')]).optional()
})

// LISTAGEM (usa view compacta) e, se desejar, pode trazer campos extras
app.get('/api/empresas', async (req, res) => {
  const p = SearchSchema.parse(req.query)
  const offset = (p.page - 1) * p.pageSize
  const useFull = p.detalhe === '1' // força usar a view completa
  const FMAP = useFull ? FIELD_MAP_FULL : FIELD_MAP_COMPACT
  const view = useFull ? 'vw_empresas_unificadas' : 'vw_empresas_compacta'

  // SELECT dinâmico
  let selects = ['cnpj'] // chave sempre presente
  if (p.fields && p.fields !== '*') {
    const wanted = p.fields.split(',').map(s => s.trim()).filter(Boolean)
    for (const w of wanted) if (FMAP[w]) selects.push(FMAP[w])
    if (selects.length === 1) selects = Object.values(FMAP) // fallback
  } else {
    selects = Object.values(FMAP)
  }

  // WHERE dinâmico
  const where = []
  const params = []

  // situação: melhor usar situacao_codigo quando possível ('2' = ATIVA)
  if (p.situacao) {
    if (p.situacao === 'ATIVA') {
      where.push('situacao_codigo = ?'); params.push('2')
    } else if (p.situacao === 'INATIVA') {
      where.push('situacao_codigo <> ?'); params.push('2')
    } else {
      where.push('situacao = ?'); params.push(p.situacao)
    }
  }

  if (p.tipo) {
    // na view compacta só temos 'status', 'situacao_codigo', não 'matriz_filial'
    if (useFull) { where.push('matriz_filial = ?'); params.push(p.tipo) }
  }

  if (p.naturezaJuridica && useFull) {
    where.push('natureza_juridica = ?'); params.push(p.naturezaJuridica)
  }

  if (p.porte && useFull) {
    where.push('porte = ?'); params.push(p.porte)
  }

  if (p.cnaePrincipal) {
    where.push('codigo = ?'); params.push(p.cnaePrincipal) // nas duas views 'codigo' = cnae_principal
  }
  if (p.buscarCnaeSecundario === '1' && p.cnaePrincipal && useFull) {
    where.push("JSON_CONTAINS(cnaes_secundarios, JSON_QUOTE(?), '$') = 1")
    params.push(p.cnaePrincipal)
  }

  const loc = parseLocalizacao(p.localizacao)
  if (loc.clause) { where.push(loc.clause); params.push(...loc.params) }

  if (p.opcaoMei && useFull) {
    where.push('opcao_mei = ?'); params.push(p.opcaoMei)
  }
  if (p.opcaoSimples && useFull) {
    where.push('opcao_simples = ?'); params.push(p.opcaoSimples)
  }

  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const sql = `
    SELECT ${selects.join(', ')}
    FROM ${view}
    ${whereSQL}
    ORDER BY atualizado_em DESC
    LIMIT ? OFFSET ?
  `
  const countSql = `
    SELECT COUNT(*) AS total
    FROM ${view}
    ${whereSQL}
  `

  try {
    const [countRows] = await pool.query(countSql, params)
    const total = Number(countRows[0]?.total || 0)
    const [rows] = await pool.query(sql, [...params, p.pageSize, offset])
    res.json({ items: rows, total })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Erro ao buscar', detail: e.message })
  }
})

// DETALHE por CNPJ (sempre usa view completa)
app.get('/api/empresas/:cnpj', async (req, res) => {
  const cnpj = (req.params.cnpj || '').replace(/\D/g, '')
  if (!/^\d{14}$/.test(cnpj)) return res.status(400).json({ error: 'CNPJ inválido' })

  const sql = `
    SELECT ${Object.values(FIELD_MAP_FULL).join(', ')}
    FROM vw_empresas_unificadas
    WHERE cnpj = ?
    LIMIT 1
  `
  try {
    const [rows] = await pool.query(sql, [cnpj])
    if (!rows.length) return res.status(404).json({ error: 'Empresa não encontrada' })
    res.json(rows[0])
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Erro ao buscar', detail: e.message })
  }
})

const PORT = Number(process.env.PORT || 3001)
app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`)
})

// em src/server.js
app.get('/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok')
    res.json({ api: 'ok', db: rows[0]?.ok === 1 ? 'ok' : 'fail' })
  } catch (e) {
    res.status(500).json({ api: 'ok', db: 'fail', detail: e.message })
  }
})

