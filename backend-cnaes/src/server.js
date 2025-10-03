// src/server.js
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import { z } from 'zod'
import { connectMongo } from './db.js'
import Empresa from './models/Empresa.js'
import { parseLocalizacao, parseCapitalSocial } from './filters.js'

mongoose.set('autoIndex', process.env.NODE_ENV !== 'production')

// ======= TUNÁVEIS DE PERF =======
const READ_PREFERENCE = process.env.MONGO_READ_PREFERENCE || 'primaryPreferred'
const DEFAULT_PAGE_SIZE = 10
const MAX_TIME_MS_PRIMARY = Number(process.env.MAX_TIME_MS || 2000)
const MAX_TIME_MS_RETRY = Number(process.env.MAX_TIME_MS_RETRY || 4000)

// Janela temporal padrão para 1ª página (sem cursor) se os filtros forem “fracos”
const DEFAULT_SINCE_DAYS = Number(process.env.DEFAULT_SINCE_DAYS || 90)
// Se nenhum filtro seletivo foi informado, aplica HARD cap (ex.: 180d)
const HARD_CAP_SINCE_DAYS = Number(process.env.HARD_CAP_SINCE_DAYS || 180)

// Códigos que NÃO são ativos para evitar $ne (ajuste se seu dataset usar outros)
// Ex.: '2' = ATIVA; os demais costumam significar não-ativa
const INATIVA_CODES = (process.env.INATIVA_CODES || '1,3,4,8,9').split(',').map(s => s.trim()).filter(Boolean)

// Projeção mínima
const LIST_FIELDS = {
  _id: 1,
  cnpj: 1,
  razao_social: 1,
  nome_fantasia: 1,
  cnae_principal: 1,
  codigo: 1,
  situacao_codigo: 1,
  matriz_filial: 1,
  natureza_juridica: 1,
  porte: 1,
  uf: 1,
  municipio_codigo: 1,
  capital_social: 1,
  atualizado_em: 1,
}
const DETAIL_FIELDS = undefined

// ======= Zod =======
const SearchSchema = z.object({
  cnaePrincipal: z.string().optional(),
  buscarCnaeSecundario: z.union([z.literal('1'), z.literal('0')]).optional(),
  localizacao: z.string().optional(),
  situacao: z.enum(['ATIVA', 'INATIVA', 'NULA', 'SUSPENSA', 'INAPTA', 'BAIXADA']).optional().or(z.string().length(0)),
  tipo: z.enum(['Matriz', 'Filial']).optional().or(z.string().length(0)),
  naturezaJuridica: z.string().optional(),
  porte: z.string().optional(),
  capitalSocial: z.string().optional(),
  opcaoMei: z.enum(['S', 'N']).optional(),
  opcaoSimples: z.enum(['S', 'N']).optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
  fields: z.string().optional(),
  detalhe: z.union([z.literal('0'), z.literal('1')]).optional(),
  // novo: deixar usuário pedir janela explícita
  sinceDays: z.coerce.number().min(1).max(3650).optional(),   // ex.: 3650 = 10 anos
  since: z.string().optional(), // ISO date
})

// ======= Cursor helpers =======
function encodeCursor(doc) {
  const ts = doc.atualizado_em ? new Date(doc.atualizado_em).toISOString() : ''
  return Buffer.from(JSON.stringify({ ts, id: String(doc._id) })).toString('base64')
}
function decodeCursor(str) {
  try {
    const raw = Buffer.from(str, 'base64').toString('utf8')
    const o = JSON.parse(raw)
    return (o && typeof o.ts === 'string' && typeof o.id === 'string') ? o : null
  } catch { return null }
}
function toObjectId(id) { try { return new mongoose.Types.ObjectId(id) } catch { return null } }

// ======= Timing (sem headers sent) =======
function timingHeader(req, res, next) {
  const start = process.hrtime.bigint()
  const origWriteHead = res.writeHead
  res.writeHead = function (...args) {
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    if (!res.headersSent) res.setHeader('X-Query-Time', ms.toFixed(2) + 'ms')
    return origWriteHead.apply(this, args)
  }
  next()
}

// ======= Heurística de seletividade & janela =======
function hasSelectiveFilter(filter) {
  // considere “seletivo” quando há igualdade em alguns campos-chave
  return Boolean(
    filter.situacao_codigo && typeof filter.situacao_codigo === 'string' ||
    filter.matriz_filial ||
    filter.natureza_juridica ||
    filter.porte ||
    filter.opcao_mei ||
    filter.opcao_simples ||
    filter.cnae_principal ||
    filter.codigo ||
    filter.cnaes_secundarios ||
    filter.uf && (filter.municipio_codigo || filter.cidade)
  )
}
function applyTimeWindowIfNeeded(filter, opts) {
  const { hasCursor, sinceDaysParam, sinceIsoParam } = opts
  if (hasCursor) return // nas páginas seguintes o keyset já restringe

  // prioridade do usuário
  if (sinceIsoParam) {
    const d = new Date(sinceIsoParam)
    if (!Number.isNaN(+d)) {
      filter.atualizado_em = Object.assign(filter.atualizado_em || {}, { $gte: d })
      return
    }
  }
  if (sinceDaysParam && Number.isFinite(sinceDaysParam)) {
    const d = new Date(Date.now() - sinceDaysParam * 86400_000)
    filter.atualizado_em = Object.assign(filter.atualizado_em || {}, { $gte: d })
    return
  }

  // heurística: se não tem filtro seletivo, aplique HARD CAP
  // if (!hasSelectiveFilter(filter)) {
  //   const d = new Date(Date.now() - HARD_CAP_SINCE_DAYS * 86400_000)
  //   filter.atualizado_em = Object.assign(filter.atualizado_em || {}, { $gte: d })
  //   return
  // }

  // se tem algum filtro, aplique uma janela razoável por padrão
  const d = new Date(Date.now() - DEFAULT_SINCE_DAYS * 86400_000)
  filter.atualizado_em = Object.assign(filter.atualizado_em || {}, { $gte: d })
}

// =================== APP ===================
; (async () => {
  await connectMongo()

  const app = express()
  app.disable('x-powered-by')
  app.set('query parser', 'simple')
  app.use(cors({ origin: true }))

  app.get('/health', async (_req, res) => {
    try {
      await Empresa.findOne({}, { _id: 1 }).read(READ_PREFERENCE).maxTimeMS(1000).lean()
      res.json({ api: 'ok', db: 'ok' })
    } catch (e) {
      res.status(500).json({ api: 'ok', db: 'fail', detail: e.message })
    }
  })

  // DEBUG – ver índices
  app.get('/debug/indexes', async (_req, res) => {
    const idx = await Empresa.collection.indexes()
    res.json(idx.map(i => ({ name: i.name, key: i.key })))
  })

  // LISTAGEM
  app.get('/api/empresas', timingHeader, async (req, res) => {
    let p
    try { p = SearchSchema.parse(req.query) }
    catch (e) { return res.status(400).json({ error: 'Parâmetros inválidos', detail: e.message }) }

    const limit = p.pageSize || DEFAULT_PAGE_SIZE

    // ===== filtros =====
    const filter = {}
    if (p.situacao) {
      if (p.situacao === 'ATIVA') {
        filter.situacao_codigo = '2'
      } else if (p.situacao === 'INATIVA') {
        // Troca $ne por $in para usar índice
        filter.situacao_codigo = { $in: INATIVA_CODES }
      } else {
        // igualdades simples tb funcionam com índice
        filter.situacao = p.situacao
      }
    }
    if (p.tipo) filter.matriz_filial = p.tipo
    if (p.naturezaJuridica) filter.natureza_juridica = p.naturezaJuridica
    if (p.porte) filter.porte = p.porte

    if (p.cnaePrincipal) {
      // Fast-path: primeiro tenta no cnae_principal apenas (mais barato)
      filter.cnae_principal = p.cnaePrincipal
      // Observação: se quiser manter busca nos 3 (principal/codigo/secundário),
      // faça outra rota ou um fallback quando principal não achar nada.
    }
    if (p.buscarCnaeSecundario === '1' && p.cnaePrincipal) {
      filter.cnaes_secundarios = { $in: [p.cnaePrincipal] }
      // se quiser cobrir "codigo" também, avalie denormalizar cnae_all
    }

    const loc = parseLocalizacao(p.localizacao) || {}
    const cap = parseCapitalSocial(p.capitalSocial) || {}
    Object.assign(filter, loc, cap)
    if (p.opcaoMei) filter.opcao_mei = p.opcaoMei
    if (p.opcaoSimples) filter.opcao_simples = p.opcaoSimples

    // ===== janela temporal na 1ª página =====
    // applyTimeWindowIfNeeded(filter, {
    //   hasCursor: Boolean(p.cursor),
    //   sinceDaysParam: p.sinceDays,
    //   sinceIsoParam: p.since,
    // })

    // ===== keyset range =====
    const sortSpec = { atualizado_em: -1, _id: -1 }
    const range = {}
    if (p.cursor) {
      const c = decodeCursor(p.cursor)
      if (c && c.ts) {
        const tsDate = new Date(c.ts)
        const oid = toObjectId(c.id)
        range.$or = oid
          ? [{ atualizado_em: { $lt: tsDate } }, { atualizado_em: tsDate, _id: { $lt: oid } }]
          : [{ atualizado_em: { $lt: tsDate } }]
      }
    }
    const finalFilter = Object.keys(range).length ? { $and: [filter, range] } : filter

    try {
      const docs = await Empresa.find(finalFilter)
        .sort(sortSpec)
        .limit(limit + 1)
        .read(READ_PREFERENCE)
        .lean()
        .maxTimeMS(MAX_TIME_MS_PRIMARY)
        .exec()

      const hasNextPage = docs.length > limit
      const items = hasNextPage ? docs.slice(0, limit) : docs
      const nextCursor = hasNextPage ? encodeCursor(items[items.length - 1]) : null

      res.setHeader('Cache-Control', 'private, max-age=5')
      return res.json({ items, pageInfo: { hasNextPage, nextCursor } })
    } catch (e) {
      const code = e && e.code != null ? String(e.code) : ''
      if (code === '50') {
        // Retry único com janela mais restrita (se ainda não tinha)
        try {
          if (!filter.atualizado_em?.$gte) {
            const fallbackDate = new Date(Date.now() - HARD_CAP_SINCE_DAYS * 86400_000)
            filter.atualizado_em = Object.assign(filter.atualizado_em || {}, { $gte: fallbackDate })
          }
          const docs = await Empresa.find(finalFilter, LIST_FIELDS)
            .sort(sortSpec)
            .limit(limit + 1)
            .read(READ_PREFERENCE)
            .lean()
            .maxTimeMS(MAX_TIME_MS_RETRY)
            .exec()

          const hasNextPage = docs.length > limit
          const items = hasNextPage ? docs.slice(0, limit) : docs
          const nextCursor = hasNextPage ? encodeCursor(items[items.length - 1]) : null

          res.setHeader('Cache-Control', 'private, max-age=5')
          return res.json({ items, pageInfo: { hasNextPage, nextCursor } })
        } catch (er2) {
          return res.status(503).json({ error: 'Query timeout', detail: er2.message })
        }
      }
      console.error('[empresas] erro:', e)
      return res.status(500).json({ error: 'Erro ao buscar', detail: e.message })
    }
  })

  // DETALHE
  app.get('/api/empresas/:cnpj', timingHeader, async (req, res) => {
    const cnpj = (req.params.cnpj || '').replace(/\D/g, '')
    if (!/^\d{14}$/.test(cnpj)) return res.status(400).json({ error: 'CNPJ inválido' })

    try {
      const doc = await Empresa.findOne({ cnpj }, DETAIL_FIELDS)
        .read(READ_PREFERENCE)
        .lean()
        .maxTimeMS(2000)
        .exec()

      if (!doc) return res.status(404).json({ error: 'Empresa não encontrada' })
      res.setHeader('Cache-Control', 'private, max-age=10')
      return res.json(doc)
    } catch (e) {
      const code = e && e.code != null ? String(e.code) : ''
      if (code === '50') return res.status(503).json({ error: 'Query timeout', detail: e.message })
      console.error('[empresa detalhe] erro:', e)
      return res.status(500).json({ error: 'Erro ao buscar', detail: e.message })
    }
  })

  const PORT = Number(process.env.PORT || 3001)
  app.listen(PORT, () => {
    console.log(`API em http://localhost:${PORT} (readPref=${READ_PREFERENCE})`)
    console.log(`Janela padrão: sinceDays=${DEFAULT_SINCE_DAYS}, hardCap=${HARD_CAP_SINCE_DAYS}`)
  })
})()
