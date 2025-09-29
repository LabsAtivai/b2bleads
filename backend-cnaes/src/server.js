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
  situacao: z.enum(['ATIVA','INATIVA','NULA','SUSPENSA','INAPTA','BAIXADA'])
             .optional().or(z.string().length(0)),
  tipo: z.enum(['Matriz','Filial']).optional().or(z.string().length(0)),
  naturezaJuridica: z.string().optional(),
  porte: z.string().optional(),
  capitalSocial: z.string().optional(),
  opcaoMei: z.enum(['S','N']).optional(),
  opcaoSimples: z.enum(['S','N']).optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(10),
  fields: z.string().optional(),
  detalhe: z.union([z.literal('0'), z.literal('1')]).optional()
})

;(async () => {
  await connectMongo()

  const app = express()
  app.use(cors())

  // LISTAGEM
  app.get('/api/empresas', async (req, res) => {
    const p = SearchSchema.parse(req.query)
    const skip = (p.page - 1) * p.pageSize

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
    if (p.cnaePrincipal) filter.codigo = p.cnaePrincipal
    if (p.buscarCnaeSecundario === '1' && p.cnaePrincipal) {
      filter.cnaes_secundarios = { $in: [p.cnaePrincipal] }
    }

    Object.assign(filter, parseLocalizacao(p.localizacao))
    Object.assign(filter, parseCapitalSocial(p.capitalSocial))

    if (p.opcaoMei) filter.opcao_mei = p.opcaoMei
    if (p.opcaoSimples) filter.opcao_simples = p.opcaoSimples

    try {
      const total = await Empresa.countDocuments(filter)

      const fields = p.fields && p.fields !== '*'
        ? p.fields.split(',').map(f => f.trim()).filter(Boolean).join(' ')
        : null

      const query = Empresa.find(filter)
      if (fields) query.select(fields)

      const items = await query
        .sort({ atualizado_em: -1 })
        .skip(skip)
        .limit(p.pageSize)

      res.json({ items, total })
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
      const empresa = await Empresa.findOne({ cnpj })
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
      await Empresa.findOne({}, { _id: 1 })
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
