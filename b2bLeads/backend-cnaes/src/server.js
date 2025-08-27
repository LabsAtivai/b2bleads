import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { z } from 'zod'
import { Parser } from 'json2csv'
import { pool } from './db.js'
import { parseLocalizacao, parseCapitalSocial } from './filters.js'

const app = express()
app.use(cors())
app.use(express.json()) // Para suportar POST e PUT

// -------------------- MAPAS DE CAMPOS --------------------
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

// -------------------- VALIDAÇÃO (Zod) --------------------
const DetalheSchema = z.union([
  z.literal('0'),
  z.literal('1'),
  z.literal('true'),
  z.literal('false'),
  z.boolean()
]).optional()

const SearchSchema = z.object({
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
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(10),
  fields: z.string().optional(),
  detalhe: DetalheSchema
})

const EstabelecimentoSchema = z.object({
  cnpj: z.string().regex(/^\d{14}$/, 'CNPJ inválido'),
  nome: z.string().min(1, 'Nome é obrigatório'),
  localidade: z.string().optional(),
  codigo: z.string().optional(),
  status: z.string().optional(),
  uf: z.string().length(2).optional(),
  cidade: z.string().optional(),
  atualizado_em: z.string().optional()
})

// -------------------- LISTAGEM EMPRESAS --------------------
app.get('/api/empresas', async (req, res) => {
  const p = SearchSchema.parse(req.query)

  const useFull = (p.detalhe === '1' || p.detalhe === 'true' || p.detalhe === true)
  const FMAP = useFull ? FIELD_MAP_FULL : FIELD_MAP_COMPACT
  const view = useFull ? 'vw_empresas_unificadas' : 'vw_empresas_compacta'

  const offset = (p.page - 1) * p.pageSize

  let selects = ['cnpj']
  if (p.fields && p.fields !== '*') {
    const wanted = p.fields.split(',').map(s => s.trim()).filter(Boolean)
    for (const w of wanted) if (FMAP[w]) selects.push(FMAP[w])
    if (selects.length === 1) selects = Object.values(FMAP)
  } else {
    selects = Object.values(FMAP)
  }

  const where = []
  const params = []

  if (p.situacao) {
    if (p.situacao === 'ATIVA') { where.push('situacao_codigo = ?'); params.push('2') }
    else if (p.situacao === 'INATIVA') { where.push('situacao_codigo <> ?'); params.push('2') }
    else { where.push('situacao = ?'); params.push(p.situacao) }
  }

  if (p.tipo && useFull) { where.push('matriz_filial = ?'); params.push(p.tipo) }
  if (p.naturezaJuridica && useFull) { where.push('natureza_juridica = ?'); params.push(p.naturezaJuridica) }
  if (p.porte && useFull) { where.push('porte = ?'); params.push(p.porte) }

  if (p.cnaePrincipal) { where.push('codigo = ?'); params.push(p.cnaePrincipal) }
  if (p.buscarCnaeSecundario === '1' && p.cnaePrincipal && useFull) {
    where.push("JSON_CONTAINS(cnaes_secundarios, JSON_QUOTE(?), '$') = 1")
    params.push(p.cnaePrincipal)
  }

  const loc = parseLocalizacao(p.localizacao)
  if (loc.clause) { where.push(loc.clause); params.push(...loc.params) }

  if (p.opcaoMei && useFull) { where.push('opcao_mei = ?'); params.push(p.opcaoMei) }
  if (p.opcaoSimples && useFull) { where.push('opcao_simples = ?'); params.push(p.opcaoSimples) }

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

// -------------------- DETALHE EMPRESA --------------------
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

// -------------------- EXPORTAÇÃO CSV --------------------
app.get('/api/empresas/export', async (req, res) => {
  try {
    const p = SearchSchema.parse(req.query)
    const useFull = (p.detalhe === '1' || p.detalhe === 'true' || p.detalhe === true)
    const FMAP = useFull ? FIELD_MAP_FULL : FIELD_MAP_COMPACT
    const view = useFull ? 'vw_empresas_unificadas' : 'vw_empresas_compacta'

    let selects = ['cnpj', 'nome', 'localidade', 'emails']
    if (p.fields && p.fields !== '*') {
      const wanted = p.fields.split(',').map(s => s.trim()).filter(Boolean)
      selects = wanted.filter(w => FMAP[w]).map(w => FMAP[w])
      if (!selects.length) selects = Object.values(FMAP)
    }

    const where = []
    const params = []

    if (p.situacao) {
      if (p.situacao === 'ATIVA') { where.push('situacao_codigo = ?'); params.push('2') }
      else if (p.situacao === 'INATIVA') { where.push('situacao_codigo <> ?'); params.push('2') }
      else { where.push('situacao = ?'); params.push(p.situacao) }
    }

    if (p.tipo && useFull) { where.push('matriz_filial = ?'); params.push(p.tipo) }
    if (p.naturezaJuridica && useFull) { where.push('natureza_juridica = ?'); params.push(p.naturezaJuridica) }
    if (p.porte && useFull) { where.push('porte = ?'); params.push(p.porte) }

    if (p.cnaePrincipal) { where.push('codigo = ?'); params.push(p.cnaePrincipal) }
    if (p.buscarCnaeSecundario === '1' && p.cnaePrincipal && useFull) {
      where.push("JSON_CONTAINS(cnaes_secundarios, JSON_QUOTE(?), '$') = 1")
      params.push(p.cnaePrincipal)
    }

    const loc = parseLocalizacao(p.localizacao)
    if (loc.clause) { where.push(loc.clause); params.push(...loc.params) }

    if (p.opcaoMei && useFull) { where.push('opcao_mei = ?'); params.push(p.opcaoMei) }
    if (p.opcaoSimples && useFull) { where.push('opcao_simples = ?'); params.push(p.opcaoSimples) }

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : ''

    const sql = `
      SELECT ${selects.join(', ')}
      FROM ${view}
      ${whereSQL}
      ORDER BY atualizado_em DESC
      LIMIT 1000
    `

    const [rows] = await pool.query(sql, params)

    if (!rows.length) {
      return res.status(404).json({ error: 'Nenhum registro encontrado' })
    }

    const fields = p.fields ? p.fields.split(',').map(s => s.trim()).filter(Boolean) : ['cnpj', 'nome', 'localidade', 'emails']
    const parser = new Parser({ fields })
    const csv = parser.parse(rows)

    res.header('Content-Type', 'text/csv')
    res.attachment('empresas.csv')
    res.send(csv)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Erro ao gerar CSV', detail: e.message })
  }
})

// -------------------- SUGESTÕES (AUTO-COMPLETE) --------------------
const SUGGEST_PAGE_SIZE = 20
const SUGGEST_FIELDS = new Set(['cnae','uf','cidade','natureza','porte','tipo','simples','mei'])

function buildWhereForSuggest(p, useFull, skipField) {
  const where = []
  const params = []

  if (p.situacao) {
    if (p.situacao === 'ATIVA') { where.push('situacao_codigo = ?'); params.push('2') }
    else if (p.situacao === 'INATIVA') { where.push('situacao_codigo <> ?'); params.push('2') }
    else { where.push('situacao = ?'); params.push(p.situacao) }
  }

  if (p.tipo && useFull && skipField !== 'tipo') { where.push('matriz_filial = ?'); params.push(p.tipo) }
  if (p.naturezaJuridica && useFull && skipField !== 'natureza') { where.push('natureza_juridica = ?'); params.push(p.naturezaJuridica) }
  if (p.porte && useFull && skipField !== 'porte') { where.push('porte = ?'); params.push(p.porte) }

  if (p.cnaePrincipal && skipField !== 'cnae') { where.push('codigo = ?'); params.push(p.cnaePrincipal) }
  if (p.buscarCnaeSecundario === '1' && p.cnaePrincipal && useFull && skipField !== 'cnae') {
    where.push("JSON_CONTAINS(cnaes_secundarios, JSON_QUOTE(?), '$') = 1")
    params.push(p.cnaePrincipal)
  }

  const loc = parseLocalizacao(p.localizacao)
  if (loc.clause && skipField !== 'cidade' && skipField !== 'uf') {
    where.push(loc.clause); params.push(...loc.params)
  }

  if (p.opcaoMei && useFull && skipField !== 'mei') { where.push('opcao_mei = ?'); params.push(p.opcaoMei) }
  if (p.opcaoSimples && useFull && skipField !== 'simples') { where.push('opcao_simples = ?'); params.push(p.opcaoSimples) }

  return { whereSQL: where.length ? 'WHERE ' + where.join(' AND ') : '', params }
}

app.get('/api/suggest/:field', async (req, res) => {
  try {
    const field = String(req.params.field || '').toLowerCase()
    if (!SUGGEST_FIELDS.has(field)) {
      return res.status(400).json({ error: 'Campo de sugestão inválido' })
    }

    const p = {
      cnaePrincipal: req.query.cnaePrincipal,
      buscarCnaeSecundario: req.query.buscarCnaeSecundario,
      localizacao: req.query.localizacao,
      situacao: req.query.situacao,
      tipo: req.query.tipo,
      naturezaJuridica: req.query.naturezaJuridica,
      porte: req.query.porte,
      opcaoMei: req.query.opcaoMei,
      opcaoSimples: req.query.opcaoSimples,
    }

    const detalhe = (req.query.detalhe === '1' || req.query.detalhe === 'true' || req.query.detalhe === true)
    const view = detalhe ? 'vw_empresas_unificadas' : 'vw_empresas_compacta'
    const q = (req.query.q || '').trim()
    const limit = Math.min(Number(req.query.limit || SUGGEST_PAGE_SIZE), 100)

    const { whereSQL, params } = buildWhereForSuggest(p, detalhe, field)

    let sql
    let map = (r) => r

    if (field === 'cnae') {
      if (q) {
        sql = `
          SELECT codigo, descricao
          FROM cnaes
          WHERE (codigo LIKE ? OR descricao LIKE ?)
          ORDER BY codigo
          LIMIT ?
        `
        params.push(`${q}%`, `%${q}%`, limit)
      } else {
        sql = `SELECT codigo, descricao FROM cnaes ORDER BY codigo LIMIT ?`
        params.push(limit)
      }
      map = (r) => ({ value: r.codigo, label: `${r.codigo} — ${r.descricao}` })
    }
    else if (field === 'uf') {
      sql = `
        SELECT DISTINCT uf
        FROM ${view}
        ${whereSQL}
        AND uf IS NOT NULL AND uf <> ''
        ${q ? 'AND uf LIKE ?' : ''}
        ORDER BY uf
        LIMIT ?
      `
      if (q) params.push(`${q.toUpperCase()}%`)
      params.push(limit)
      map = (r) => ({ value: r.uf, label: r.uf })
    }
    else if (field === 'cidade') {
      const extraUf = /^[A-Za-z]{2}$/.test(req.query.uf || '') ? String(req.query.uf).toUpperCase() : null
      sql = `
        SELECT DISTINCT cidade
        FROM ${view}
        ${whereSQL}
        ${whereSQL ? 'AND' : 'WHERE'} cidade IS NOT NULL AND cidade <> ''
        ${extraUf ? 'AND uf = ?' : ''}
        ${q ? 'AND cidade LIKE ?' : ''}
        ORDER BY cidade
        LIMIT ?
      `
      if (extraUf) params.push(extraUf)
      if (q) params.push(`${q}%`)
      params.push(limit)
      map = (r) => ({ value: r.cidade, label: r.cidade })
    }
    else if (field === 'natureza') {
      if (q) {
        sql = `
          SELECT codigo, descricao
          FROM naturezas_juridicas
          WHERE (codigo LIKE ? OR descricao LIKE ?)
          ORDER BY codigo
          LIMIT ?
        `
        params.push(`${q}%`, `%${q}%`, limit)
      } else {
        sql = `SELECT codigo, descricao FROM naturezas_juridicas ORDER BY codigo LIMIT ?`
        params.push(limit)
      }
      map = (r) => ({ value: r.codigo, label: `${r.codigo} — ${r.descricao}` })
    }
    else if (field === 'porte') {
      sql = `
        SELECT DISTINCT porte
        FROM vw_empresas_unificadas
        ${whereSQL}
        AND porte IS NOT NULL AND porte <> ''
        ${q ? 'AND porte LIKE ?' : ''}
        ORDER BY porte
        LIMIT ?
      `
      if (q) params.push(`${q.toUpperCase()}%`)
      params.push(limit)
      map = (r) => ({ value: r.porte, label: r.porte })
    }
    else if (field === 'tipo') {
      sql = `
        SELECT DISTINCT matriz_filial
        FROM vw_empresas_unificadas
        ${whereSQL}
        AND matriz_filial IS NOT NULL AND matriz_filial <> ''
        ${q ? 'AND matriz_filial LIKE ?' : ''}
        ORDER BY matriz_filial
        LIMIT ?
      `
      if (q) params.push(q.charAt(0).toUpperCase() + q.slice(1) + '%')
      params.push(limit)
      map = (r) => ({ value: r.matriz_filial, label: r.matriz_filial })
    }
    else if (field === 'simples') {
      sql = `
        SELECT DISTINCT opcao_simples
        FROM vw_empresas_unificadas
        ${whereSQL}
        AND opcao_simples IN ('S','N')
        ORDER BY opcao_simples DESC
        LIMIT ?
      `
      params.push(limit)
      map = (r) => ({ value: r.opcao_simples, label: r.opcao_simples === 'S' ? 'Sim' : 'Não' })
    }
    else if (field === 'mei') {
      sql = `
        SELECT DISTINCT opcao_mei
        FROM vw_empresas_unificadas
        ${whereSQL}
        AND opcao_mei IN ('S','N')
        ORDER BY opcao_mei DESC
        LIMIT ?
      `
      params.push(limit)
      map = (r) => ({ value: r.opcao_mei, label: r.opcao_mei === 'S' ? 'Sim' : 'Não' })
    }

    const [rows] = await pool.query(sql, params)
    res.json({ items: rows.map(map) })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Erro nas sugestões', detail: e.message })
  }
})

// -------------------- ESTABELECIMENTO CRUD --------------------
app.get('/api/estabelecimento', async (req, res) => {
  try {
    const p = SearchSchema.parse(req.query)
    const offset = (p.page - 1) * p.pageSize
    const where = []
    const params = []

    if (p.situacao) {
      if (p.situacao === 'ATIVA') { where.push('situacao_codigo = ?'); params.push('2') }
      else if (p.situacao === 'INATIVA') { where.push('situacao_codigo <> ?'); params.push('2') }
      else { where.push('situacao = ?'); params.push(p.situacao) }
    }

    const loc = parseLocalizacao(p.localizacao)
    if (loc.clause) { where.push(loc.clause); params.push(...loc.params) }

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : ''

    const sql = `
      SELECT ${Object.values(FIELD_MAP_COMPACT).join(', ')}
      FROM vw_estabelecimentos
      ${whereSQL}
      ORDER BY atualizado_em DESC
      LIMIT ? OFFSET ?
    `
    const countSql = `
      SELECT COUNT(*) AS total
      FROM vw_estabelecimentos
      ${whereSQL}
    `

    const [countRows] = await pool.query(countSql, params)
    const total = Number(countRows[0]?.total || 0)
    const [rows] = await pool.query(sql, [...params, p.pageSize, offset])
    res.json({ items: rows, total })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Erro ao buscar estabelecimentos', detail: e.message })
  }
})

app.get('/api/estabelecimento/:cnpj', async (req, res) => {
  const cnpj = (req.params.cnpj || '').replace(/\D/g, '')
  if (!/^\d{14}$/.test(cnpj)) return res.status(400).json({ error: 'CNPJ inválido' })

  const sql = `
    SELECT ${Object.values(FIELD_MAP_FULL).join(', ')}
    FROM vw_estabelecimentos
    WHERE cnpj = ?
    LIMIT 1
  `
  try {
    const [rows] = await pool.query(sql, [cnpj])
    if (!rows.length) return res.status(404).json({ error: 'Estabelecimento não encontrado' })
    res.json(rows[0])
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Erro ao buscar estabelecimento', detail: e.message })
  }
})

app.post('/api/estabelecimento', async (req, res) => {
  try {
    const data = EstabelecimentoSchema.parse(req.body)
    const sql = `
      INSERT INTO estabelecimentos (cnpj, nome, localidade, codigo, status, uf, cidade, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `
    const params = [
      data.cnpj,
      data.nome,
      data.localidade || null,
      data.codigo || null,
      data.status || null,
      data.uf || null,
      data.cidade || null
    ]
    const [result] = await pool.query(sql, params)
    res.status(201).json({ id: result.insertId, ...data })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Erro ao criar estabelecimento', detail: e.message })
  }
})

app.put('/api/estabelecimento/:cnpj', async (req, res) => {
  const cnpj = (req.params.cnpj || '').replace(/\D/g, '')
  if (!/^\d{14}$/.test(cnpj)) return res.status(400).json({ error: 'CNPJ inválido' })

  try {
    const data = EstabelecimentoSchema.parse(req.body)
    const sql = `
      UPDATE estabelecimentos
      SET nome = ?, localidade = ?, codigo = ?, status = ?, uf = ?, cidade = ?, atualizado_em = NOW()
      WHERE cnpj = ?
    `
    const params = [
      data.nome,
      data.localidade || null,
      data.codigo || null,
      data.status || null,
      data.uf || null,
      data.cidade || null,
      cnpj
    ]
    const [result] = await pool.query(sql, params)
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Estabelecimento não encontrado' })
    res.json({ cnpj, ...data })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Erro ao atualizar estabelecimento', detail: e.message })
  }
})

app.delete('/api/estabelecimento/:cnpj', async (req, res) => {
  const cnpj = (req.params.cnpj || '').replace(/\D/g, '')
  if (!/^\d{14}$/.test(cnpj)) return res.status(400).json({ error: 'CNPJ inválido' })

  try {
    const sql = `DELETE FROM estabelecimentos WHERE cnpj = ?`
    const [result] = await pool.query(sql, [cnpj])
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Estabelecimento não encontrado' })
    res.status(204).send()
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Erro ao deletar estabelecimento', detail: e.message })
  }
})

// -------------------- HEALTH --------------------
app.get('/health', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok')
    res.json({ api: 'ok', db: rows[0]?.ok === 1 ? 'ok' : 'fail' })
  } catch (e) {
    res.status(500).json({ api: 'ok', db: 'fail', detail: e.message })
  }
})

const PORT = Number(process.env.PORT || 3001)
app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`)
})