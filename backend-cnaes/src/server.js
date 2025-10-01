import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { z } from 'zod'
import { connectMongo } from './db.js'
import Empresa from './models/Empresa.js'
import { parseLocalizacao, parseCapitalSocial } from './filters.js'

const SearchSchema = z.object({
  cnaePrincipal: z.string().optional(),
  buscarCnaeSecundario: z.union([z.literal('1'), z.literal('0')]).optional(),
  localizacao: z.string().optional(),
  situacao: z.enum(['ATIVA', 'INATIVA', 'NULA', 'SUSPENSA', 'INAPTA', 'BAIXADA'])
    .optional().or(z.string().length(0)),
  tipo: z.enum(['Matriz', 'Filial']).optional().or(z.string().length(0)),
  naturezaJuridica: z.string().optional(),
  porte: z.string().optional(),
  capitalSocial: z.string().optional(),
  opcaoMei: z.enum(['S', 'N']).optional(),
  opcaoSimples: z.enum(['S', 'N']).optional(),
  // page e pageSize ficam só por compat, mas vamos usar cursor.
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(10),
  // cursor opcional (base64)
  cursor: z.string().optional(),
  // sem projeção
  fields: z.string().optional(),
  detalhe: z.union([z.literal('0'), z.literal('1')]).optional()
})

// helpers de cursor (atualizado_em, _id)
function encodeCursor(doc) {
  // usamos ISO + _id para desempate estável
  const ts = doc.atualizado_em ? new Date(doc.atualizado_em).toISOString() : ''
  const raw = JSON.stringify({ ts, id: String(doc._id) })
  return Buffer.from(raw).toString('base64')
}
function decodeCursor(str) {
  try {
    const raw = Buffer.from(str, 'base64').toString('utf8')
    const obj = JSON.parse(raw)
    if (!obj || typeof obj.ts !== 'string' || typeof obj.id !== 'string') return null
    return obj
  } catch {
    return null
  }
}

; (async () => {
  await connectMongo()

  await Empresa.syncIndexes()
  const app = express()
  app.use(cors())

  // LISTAGEM — keyset pagination
  app.get('/api/empresas', async (req, res) => {
    const p = SearchSchema.parse(req.query)
    const limit = p.pageSize

    // ==== monta filtro ====
    const filter = {}

    if (p.situacao) {
      if (p.situacao === 'ATIVA') {
        filter.situacao_codigo = '2'
      } else if (p.situacao === 'INATIVA') {
        filter.situacao_codigo = { $ne: '2' }
      } else {
        filter.situacao = p.situacao
      }
    }

    if (p.tipo) filter.matriz_filial = p.tipo
    if (p.naturezaJuridica) filter.natureza_juridica = p.naturezaJuridica
    if (p.porte) filter.porte = p.porte

    // CNAE principal (aceita cnae_principal ou codigo)
    if (p.cnaePrincipal) {
      filter.$or = [{ cnae_principal: p.cnaePrincipal }, { codigo: p.cnaePrincipal }]
    }
    if (p.buscarCnaeSecundario === '1' && p.cnaePrincipal) {
      filter.cnaes_secundarios = { $in: [p.cnaePrincipal] }
    }

    Object.assign(filter, parseLocalizacao(p.localizacao))
    Object.assign(filter, parseCapitalSocial(p.capitalSocial))

    if (p.opcaoMei) filter.opcao_mei = p.opcaoMei
    if (p.opcaoSimples) filter.opcao_simples = p.opcaoSimples

    // ==== keyset a partir do cursor ====
    // Ordenação fixa (para casar com o índice): atualizado_em desc, _id desc
    const sortSpec = { atualizado_em: -1, _id: -1 }

    const range = {}
    if (p.cursor) {
      const c = decodeCursor(p.cursor)
      if (c && c.ts) {
        // Queremos docs *depois* do cursor em ordem desc:
        // (atualizado_em < ts) OR (atualizado_em == ts AND _id < cursor_id)
        const tsDate = new Date(c.ts)
        range.$or = [
          { atualizado_em: { $lt: tsDate } },
          { atualizado_em: tsDate, _id: { $lt: c.id } }
        ]
      }
    }

    // Junta range com filtros
    const finalFilter = Object.keys(range).length ? { $and: [filter, range] } : filter

    try {
      // Busca limit + 1 pra saber se tem próxima página
      const docs = await Empresa.find(finalFilter)
        .sort(sortSpec)
        .limit(limit + 1)
        .lean()

      const hasNextPage = docs.length > limit
      const items = hasNextPage ? docs.slice(0, limit) : docs
      const nextCursor = hasNextPage ? encodeCursor(items[items.length - 1]) : null

      // Evita countDocuments (caro). Se você realmente precisar do total,
      // crie um endpoint separado que rode uma noite ou calcule por materialização.
      res.json({
        items,
        pageInfo: {
          hasNextPage,
          nextCursor
        }
      })
    } catch (e) {
      console.error(e)
      res.status(500).json({ error: 'Erro ao buscar', detail: e.message })
    }
  })

  // DETALHE por CNPJ
  app.get('/api/empresas/:cnpj', async (req, res) => {
    const cnpj = (req.params.cnpj || '').replace(/\D/g, '')
    if (!/^\d{14}$/.test(cnpj)) {
      return res.status(400).json({ error: 'CNPJ inválido' })
    }

    try {
      const empresa = await Empresa.findOne({ cnpj }).lean()
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada' })
      res.json(empresa)
    } catch (e) {
      console.error(e)
      res.status(500).json({ error: 'Erro ao buscar', detail: e.message })
    }
  })

  // Health check
  app.get('/health', async (req, res) => {
    try {
      await Empresa.findOne({}, { _id: 1 }).lean()
      res.json({ api: 'ok', db: 'ok' })
    } catch (e) {
      res.status(500).json({ api: 'ok', db: 'fail', detail: e.message })
    }
  })

  const PORT = Number(process.env.PORT || 3001)
  app.listen(PORT, () => {
    console.log(`API rodando em http://localhost:${PORT}`)
  })
})()
