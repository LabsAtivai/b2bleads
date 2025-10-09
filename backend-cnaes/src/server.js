// src/server.js
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import { z } from 'zod'
import { connectMongo } from './db.js'
import Empresa from './models/Empresa.js'
import { parseCapitalSocial } from './filters.js'

mongoose.set('autoIndex', process.env.NODE_ENV !== 'production')

// ======= TUNÁVEIS DE PERF =======
const READ_PREFERENCE = process.env.MONGO_READ_PREFERENCE || 'primaryPreferred'
const DEFAULT_PAGE_SIZE = 10
const MAX_TIME_MS_PRIMARY = Number(process.env.MAX_TIME_MS || 2000)
const MAX_TIME_MS_RETRY = Number(process.env.MAX_TIME_MS_RETRY || 4000)

// códigos não-ativos (ajuste conforme dataset)
const INATIVA_CODES = (process.env.INATIVA_CODES || '1,3,4,8,9')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// ======= PROJEÇÕES =======
const LIST_FIELDS = {
  _id: 1,
  cnpj: 1,
  razao_social: 1,
  nome_fantasia: 1,
  cnae_principal: 1,
  codigo: 1,
  situacao: 1,
  situacao_codigo: 1,
  matriz_filial: 1,
  natureza_juridica: 1,
  natureza_juridica_desc: 1,
  porte: 1,
  porte_codigo: 1,
  uf: 1,
  cidade: 1,
  municipio_codigo: 1,
  cep: 1,
  capital_social: 1,
}
const DETAIL_FIELDS = undefined // tudo

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
})

// ======= Cursor helpers (id-only) =======
function encodeCursor(doc) {
  return Buffer.from(JSON.stringify({ id: String(doc._id) })).toString('base64')
}
function decodeCursor(str) {
  try {
    const raw = Buffer.from(str, 'base64').toString('utf8')
    const o = JSON.parse(raw)
    return (o && typeof o.id === 'string') ? o : null
  } catch { return null }
}
function toObjectId(id) { try { return new mongoose.Types.ObjectId(id) } catch { return null } }

// ======= Timing header =======
function timingHeader(_req, res, next) {
  const start = process.hrtime.bigint()
  const origWriteHead = res.writeHead
  res.writeHead = function (...args) {
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    if (!res.headersSent) res.setHeader('X-Query-Time', ms.toFixed(2) + 'ms')
    return origWriteHead.apply(this, args)
  }
  next()
}

// ======= LIKE helpers =======
// Escapa p/ regex
const reEscape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// %termo% (case-insensitive) -> RegExp real
const like = s => new RegExp(reEscape(String(s)), 'i')
// Campo string ou numérico: tenta direto e fallback via $toString
const likeField = (field, val) => ({
  $or: [
    { [field]: like(val) },
    {
      $expr: {
        $regexMatch: {
          input: { $toString: `$${field}` },
          regex: reEscape(String(val)),
          options: 'i',
        },
      },
    },
  ],
})

  // =================== APP ===================
  ; (async () => {
    await connectMongo()

    const app = express()
    app.disable('x-powered-by')
    app.set('query parser', 'simple')
    app.use(cors({ origin: true }))

    // HEALTH
    app.get('/health', async (_req, res) => {
      try {
        await Empresa.findOne({}, { _id: 1 }).read(READ_PREFERENCE).maxTimeMS(1000).lean()
        res.json({ api: 'ok', db: 'ok' })
      } catch (e) {
        res.status(500).json({ api: 'ok', db: 'fail', detail: e.message })
      }
    })

    // DEBUG – índices
    app.get('/debug/indexes', async (_req, res) => {
      const idx = await Empresa.collection.indexes()
      res.json(idx.map(i => ({ name: i.name, key: i.key })))
    })

    // LISTAGEM (LIKE = %termo% em tudo; sem filter/sort por atualizado_em)
    app.get('/api/empresas', timingHeader, async (req, res) => {
      let p
      try { p = SearchSchema.parse(req.query) }
      catch (e) { return res.status(400).json({ error: 'Parâmetros inválidos', detail: e.message }) }

      const limit = p.pageSize || DEFAULT_PAGE_SIZE

      // ===== filtros (LIKE em strings e tolerante a numéricos) =====
      const and = []
      const or = []

      // Situação (label ou código) — sempre %termo%
      if (p.situacao) {
        const sit = String(p.situacao).toUpperCase()
        if (sit === 'ATIVA') {
          or.push({ situacao_codigo: like('2') }, { situacao: like('ATIVA') })
        } else if (sit === 'INATIVA') {
          or.push(
            { situacao: like('INATIVA') },
            { situacao: like('NULA') },
            { situacao: like('SUSPENSA') },
            { situacao: like('INAPTA') },
            { situacao: like('BAIXADA') },
            { situacao_codigo: { $in: INATIVA_CODES.map(code => like(code)) } }
          )
        } else {
          or.push({ situacao: like(p.situacao) }, { situacao_codigo: like(p.situacao) })
        }
      }

      // Tipo (Matriz/Filial)
      if (p.tipo) and.push({ matriz_filial: like(p.tipo) })

      // Natureza jurídica (código/descrição)
      if (p.naturezaJuridica) {
        or.push(
          { natureza_juridica: like(p.naturezaJuridica) },
          { natureza_juridica_desc: like(p.naturezaJuridica) }
        )
      }

      // Porte (código/descrição)
      if (p.porte) {
        or.push(
          { porte: like(p.porte) },
          { porte_codigo: like(p.porte) }
        )
      }

      // CNAE principal / "codigo" / secundários / empresas_agg (like = %termo%)
      if (p.cnaePrincipal) {
        const rx = like(p.cnaePrincipal)
        const cnaesOr = [
          // seu schema "empresas"
          { cnae_principal: rx },
          { codigo: rx },
          { cnaes_secundarios: rx }, // array -> regex direto funciona

          // campos do agregado (se houverem mapeados no mesmo documento)
          { cnaeFiscalPrincipalCodigo: rx },
          { 'estabelecimentos.cnaeFiscalPrincipalCodigo': rx }, // dentro do array
        ]
        if (p.buscarCnaeSecundario === '1') {
          // já coberto por cnaes_secundarios; mantido por clareza
          cnaesOr.push({ cnaes_secundarios: rx })
        }
        and.push({ $or: cnaesOr })
      }

      // Localização livre (uf/cidade/municipio_codigo/cep) — %termo%
      if (p.localizacao) {
        or.push(
          likeField('uf', p.localizacao),
          likeField('cidade', p.localizacao),
          likeField('municipio_codigo', p.localizacao),
          likeField('cep', p.localizacao)
        )
      }

      // Simples & MEI — %termo%
      if (p.opcaoMei) and.push({ opcao_mei: like(p.opcaoMei) })
      if (p.opcaoSimples) and.push({ opcao_simples: like(p.opcaoSimples) })

      // Capital social (range)
      const cap = parseCapitalSocial(p.capitalSocial) || {}
      if (Object.keys(cap).length) and.push(cap)

      // Junta filtro final
      if (or.length) and.push({ $or: or })
      const filter = and.length ? { $and: and } : {}

      // ===== keyset range (somente _id) =====
      const sortSpec = { _id: -1 }
      const range = {}
      if (p.cursor) {
        const c = decodeCursor(p.cursor)
        const oid = c ? toObjectId(c.id) : null
        if (oid) range._id = { $lt: oid }
      }
      const finalFilter = Object.keys(range).length ? { $and: [filter, range] } : filter

      try {
        const docs = await Empresa.find(
          finalFilter
        )
          .sort(sortSpec)
          .limit(limit + 1)
          .read(READ_PREFERENCE)
          .collation({ locale: 'pt', strength: 1 }) // ignora acentos/maiúsculas
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
          try {
            const docs = await Empresa.find(
              finalFilter,
              p.detalhe === '1' ? DETAIL_FIELDS : LIST_FIELDS
            )
              .sort(sortSpec)
              .limit(limit + 1)
              .read(READ_PREFERENCE)
              .collation({ locale: 'pt', strength: 1 })
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
    })
  })()
