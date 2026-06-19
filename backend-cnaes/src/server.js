// src/server.js
import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(process.cwd(), ".env") });

import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { z } from "zod";
import ExcelJS from "exceljs";

import { connectMongo } from "./db.js";
import Empresa from "./models/Empresa.js";
import { parseCapitalSocial } from "./filters.js";

// ======= CONFIG =======
const READ_PREFERENCE = process.env.MONGO_READ_PREFERENCE || "primaryPreferred";
const DEFAULT_PAGE_SIZE = 10;
const MAX_TIME_MS_PRIMARY = Number(process.env.MAX_TIME_MS || 2000);
const MAX_TIME_MS_RETRY = Number(process.env.MAX_TIME_MS_RETRY || 8000);
const MAX_EXPORT_ROWS = Number(process.env.MAX_EXPORT_ROWS || 50000); // [FIX] limite de exportação

const INATIVA_CODES = (process.env.INATIVA_CODES || "1,3,4,8,9")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// [FIX] CORS: lista de origens via env (em dev aceita localhost, em prod restringe)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:5173", "http://localhost:3000"];

// ======= HELPERS =======
const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const like = (s) => new RegExp(reEscape(String(s)), "i");

function encodeCursor(doc) {
  return Buffer.from(JSON.stringify({ id: String(doc._id) })).toString("base64");
}
function decodeCursor(str) {
  try {
    const raw = Buffer.from(str, "base64").toString("utf8");
    const o = JSON.parse(raw);
    return o && typeof o.id === "string" ? o : null;
  } catch {
    return null;
  }
}

function buildPorteFilter(porteInput) {
  if (!porteInput) return null;
  const porte = String(porteInput).trim().toUpperCase();
  const map = {
    "1": ["1", "01", "NÃO INFORMADO"],
    "2": ["2", "02", "MICRO EMPRESA"],
    "3": ["3", "03", "EMPRESA DE PEQUENO PORTE"],
    "5": ["5", "05", "DEMAIS"],
  };
  let keys = [];
  if (map[porte]) {
    keys = map[porte];
  } else {
    Object.values(map).forEach((arr) => {
      if (arr.some((v) => v.includes(porte))) keys.push(...arr);
    });
  }
  if (!keys.length) return null;
  return {
    $or: [
      { "porte.codigo": { $in: keys } },
      { "porte.descricao": { $in: keys } },
    ],
  };
}

function toObjectId(id) {
  try {
    return new mongoose.Types.ObjectId(id);
  } catch {
    return null;
  }
}

// ======= Zod schema =======
const SearchSchema = z.object({
  nome: z.string().optional(),
  nomeFantasia: z.string().optional(),
  cnpj: z.string().optional(),
  cnaePrincipal: z.string().optional(),
  buscarCnaeSecundario: z.union([z.literal("1"), z.literal("0")]).optional(),
  localizacao: z.string().optional(),
  uf: z.string().optional(),
  cidade: z.string().optional(),
  cep: z.string().optional(),
  situacao: z.string().optional(),
  tipo: z.string().optional(),
  naturezaJuridica: z.string().optional(),
  porte: z.string().optional(),
  capitalSocial: z.string().optional(),
  email: z.string().optional(),
  temEmail: z.union([z.literal("1"), z.literal("0")]).optional(),
  temTelefone: z.union([z.literal("1"), z.literal("0")]).optional(),
  telefone: z.string().optional(),
  simplesNacional: z.string().optional(),
  dataAberturaMin: z.string().optional(),
  dataAberturaMax: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
});

// ======= Middleware: Query timing =======
function timingHeader(_req, res, next) {
  const start = process.hrtime.bigint();
  const orig = res.writeHead;
  res.writeHead = function (...args) {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (!res.headersSent) res.setHeader("X-Query-Time", ms.toFixed(2) + "ms");
    return orig.apply(this, args);
  };
  next();
}

// [FIX] buildFilter extraído — elimina triplicação de código
function buildFilter(p) {
  const and = [];

  if (p.nome) and.push({ razaoSocial: like(p.nome) });

  if (p.nomeFantasia)
    and.push({ "estabelecimentos.nomeFantasia": like(p.nomeFantasia) });

  if (p.cnpj) {
    const cnpjDigits = p.cnpj.replace(/\D/g, "");
    if (cnpjDigits.length === 14) {
      and.push({ "estabelecimentos.cnpj": cnpjDigits });
    } else if (cnpjDigits.length > 0) {
      and.push({ "estabelecimentos.cnpj": new RegExp(reEscape(cnpjDigits)) });
    }
  }

  if (p.email) {
    const rx = like(p.email);
    and.push({
      $or: [
        { "estabelecimentos.email": rx },
        { "estabelecimentos.contatos.email": rx },
      ],
    });
  }

  if (p.situacao) {
    const sitMap = {
      ATIVA: "02", NULA: "01", SUSPENSA: "03",
      INAPTA: "04", BAIXADA: "08", CANCELADA: "09",
    };
    const sit = p.situacao.toUpperCase();
    if (sit === "INATIVA") {
      and.push({ "estabelecimentos.situacaoCadastral": { $in: INATIVA_CODES } });
    } else if (sitMap[sit]) {
      and.push({ "estabelecimentos.situacaoCadastral": sitMap[sit] });
    } else {
      and.push({ "estabelecimentos.situacaoCadastral": like(sit) });
    }
  }

  if (p.porte) {
    const porteFilter = buildPorteFilter(p.porte);
    if (porteFilter) and.push(porteFilter);
  }

  if (p.naturezaJuridica) {
    const rx = like(p.naturezaJuridica);
    and.push({ $or: [{ "natureza.codigo": rx }, { "natureza.descricao": rx }] });
  }

  if (p.cnaePrincipal) {
    const rawCnae = p.cnaePrincipal.trim();
    const digits = rawCnae.replace(/\D/g, "");
    const rx = like(rawCnae);
    const cnaeOr = [];
    if (digits.length >= 4) {
      cnaeOr.push({ "estabelecimentos.cnaeFiscalPrincipalCodigo": digits });
    }
    cnaeOr.push(
      { "estabelecimentos.cnaeFiscalPrincipal.codigo": rx },
      { "estabelecimentos.cnaeFiscalPrincipal.descricao": rx }
    );

    if (p.buscarCnaeSecundario === "1") {
      const rxSec = like(rawCnae);
      if (digits.length >= 4) {
        cnaeOr.push({ "estabelecimentos.cnaesSecundariosCodigos": digits });
      } else {
        cnaeOr.push({ "estabelecimentos.cnaesSecundariosCodigos": rxSec });
      }
    }

    and.push({ $or: cnaeOr });
  }

  if (p.localizacao) {
    const raw = p.localizacao.trim();
    const hasDash = raw.includes("-");
    const isUf = /^[A-Za-z]{2}$/.test(raw);
    const isCep = /^\d{5}-?\d{3}$/.test(raw);

    if (hasDash) {
      const [cidade, uf] = raw.split("-").map((s) => s.trim());
      and.push({
        estabelecimentos: {
          $elemMatch: {
            "endereco.municipio.descricao": new RegExp(reEscape(cidade), "i"),
            "endereco.uf": uf.toUpperCase(),
          },
        },
      });
    } else if (isUf) {
      and.push({
        estabelecimentos: { $elemMatch: { "endereco.uf": raw.toUpperCase() } },
      });
    } else if (isCep) {
      const cepDigits = raw.replace(/\D/g, "");
      and.push({
        estabelecimentos: { $elemMatch: { "endereco.cep": cepDigits } },
      });
    } else {
      and.push({
        estabelecimentos: {
          $elemMatch: {
            "endereco.municipio.descricao": new RegExp(reEscape(raw), "i"),
          },
        },
      });
    }
  }

  // Filtros de localização separados (uf, cidade, cep)
  if (p.uf && p.cidade) {
    and.push({
      estabelecimentos: {
        $elemMatch: {
          "endereco.municipio.descricao": new RegExp(reEscape(p.cidade.trim()), "i"),
          "endereco.uf": p.uf.trim().toUpperCase(),
        },
      },
    });
  } else if (p.uf) {
    and.push({
      estabelecimentos: { $elemMatch: { "endereco.uf": p.uf.trim().toUpperCase() } },
    });
  } else if (p.cidade) {
    and.push({
      estabelecimentos: {
        $elemMatch: {
          "endereco.municipio.descricao": new RegExp(reEscape(p.cidade.trim()), "i"),
        },
      },
    });
  }

  if (p.cep) {
    const cepDigits = p.cep.replace(/\D/g, "");
    if (cepDigits.length >= 5) {
      and.push({
        estabelecimentos: { $elemMatch: { "endereco.cep": new RegExp("^" + reEscape(cepDigits)) } },
      });
    }
  }

  // Capital social
  const cap = parseCapitalSocial(p.capitalSocial) || {};
  if (Object.keys(cap).length) and.push(cap);

  // Telefone
  if (p.telefone) {
    const tel = p.telefone.replace(/\D/g, "");
    if (tel.length > 0) {
      const rxTel = new RegExp(reEscape(tel));
      and.push({
        $or: [
          { "estabelecimentos.telefones": rxTel },
          { "estabelecimentos.contatos.telefone1": rxTel },
          { "estabelecimentos.contatos.telefone2": rxTel },
        ],
      });
    }
  }

  // "Tem email" / "Tem telefone"
  if (p.temEmail === "1") {
    and.push({
      $or: [
        { "estabelecimentos.email": { $exists: true, $ne: "" } },
        { "estabelecimentos.contatos.email": { $exists: true, $ne: "" } },
      ],
    });
  }
  if (p.temTelefone === "1") {
    and.push({
      $or: [
        { "estabelecimentos.telefones.0": { $exists: true } },
        { "estabelecimentos.contatos.telefone1": { $exists: true, $ne: "" } },
      ],
    });
  }

  // Simples Nacional / MEI
  if (p.simplesNacional) {
    const opt = p.simplesNacional.toUpperCase();
    if (opt === "SIMPLES") and.push({ "simples.opcaoSimples": true });
    else if (opt === "MEI") and.push({ "simples.opcaoMei": true });
    else if (opt === "NAO") and.push({
      $or: [
        { "simples.opcaoSimples": { $ne: true } },
        { simples: null },
      ],
    });
  }

  // Data de abertura (formato YYYYMMDD nos dados da RF)
  if (p.dataAberturaMin || p.dataAberturaMax) {
    const dateFilter = {};
    if (p.dataAberturaMin) {
      const d = p.dataAberturaMin.replace(/\D/g, "");
      if (d.length === 8) dateFilter.$gte = d;
    }
    if (p.dataAberturaMax) {
      const d = p.dataAberturaMax.replace(/\D/g, "");
      if (d.length === 8) dateFilter.$lte = d;
    }
    if (Object.keys(dateFilter).length) {
      and.push({ "estabelecimentos.dataInicioAtividade": dateFilter });
    }
  }

  return and.length ? { $and: and } : {};
}

// =================== APP ===================
(async () => {
  await connectMongo();

  const app = express();
  app.disable("x-powered-by");

  // [FIX] CORS restrito a origens configuradas
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`Origem não permitida: ${origin}`));
      },
    })
  );

  // HEALTH
  app.get("/health", async (_req, res) => {
    try {
      await Empresa.findOne({}, { _id: 1 }).read(READ_PREFERENCE).maxTimeMS(1000).lean();
      res.json({ api: "ok", db: "ok" });
    } catch (e) {
      res.status(500).json({ api: "ok", db: "fail", detail: e.message });
    }
  });

  // ======= LISTAGEM PRINCIPAL =======
  app.get("/api/empresas", timingHeader, async (req, res) => {
    let p;
    try {
      p = SearchSchema.parse(req.query);
    } catch (e) {
      return res.status(400).json({ error: "Parâmetros inválidos", detail: e.message });
    }

    const limit = p.pageSize || DEFAULT_PAGE_SIZE;
    const filter = buildFilter(p); // [FIX] usa função centralizada

    const sortSpec = { _id: -1 };
    const range = {};
    if (p.cursor) {
      const c = decodeCursor(p.cursor);
      const oid = c ? toObjectId(c.id) : null;
      if (oid) range._id = { $lt: oid };
    }
    const finalFilter = Object.keys(range).length
      ? { $and: [filter, range] }
      : filter;

    try {
      async function runFind() {
        try {
          return await Empresa.find(finalFilter)
            .sort(sortSpec)
            .limit(limit + 1)
            .read(READ_PREFERENCE)
            .lean()
            .maxTimeMS(MAX_TIME_MS_PRIMARY)
            .exec();
        } catch (e) {
          if (e.code === 50) {
            console.warn("[/api/empresas] MaxTimeMSExpired, retry com secondaryPreferred...");
            return await Empresa.find(finalFilter)
              .sort(sortSpec)
              .limit(limit + 1)
              .read("secondaryPreferred")
              .lean()
              .maxTimeMS(MAX_TIME_MS_RETRY)
              .exec();
          }
          throw e;
        }
      }

      // [FIX] count só na primeira página (sem cursor) para não sobrecarregar
      const countPromise =
        !p.cursor
          ? Empresa.countDocuments(filter)
              .read(READ_PREFERENCE)
              .maxTimeMS(MAX_TIME_MS_RETRY)
              .exec()
              .catch((err) => {
                console.warn("[/api/empresas] countDocuments falhou:", err.message);
                return undefined;
              })
          : Promise.resolve(undefined);

      const [docs, total] = await Promise.all([runFind(), countPromise]);

      const hasNextPage = docs.length > limit;
      const items = hasNextPage ? docs.slice(0, limit) : docs;
      const nextCursor = hasNextPage ? encodeCursor(items[items.length - 1]) : null;

      res.json({
        items,
        total: total ?? items.length,
        pageInfo: { hasNextPage, nextCursor },
      });
    } catch (e) {
      console.error("[/api/empresas] erro:", e);
      res.status(500).json({ error: "Erro ao buscar", detail: e.message });
    }
  });

  // ======= EXPORTAÇÃO CSV =======
  app.get("/api/empresas.csv", timingHeader, async (req, res) => {
    let p;
    try {
      p = SearchSchema.parse(req.query);
    } catch (e) {
      return res.status(400).json({ error: "Parâmetros inválidos", detail: e.message });
    }

    const filter = buildFilter(p); // [FIX] usa função centralizada

    try {
      const filename = `empresas_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Cache-Control", "no-cache");
      res.write("\uFEFF");

      const header = ["CNPJ", "RazaoSocial", "NomeFantasia", "Email", "CidadeUF", "CNAE", "Telefone", "Porte", "NaturezaJuridica"];
      res.write(header.join(",") + "\r\n");

      const csvEscape = (val) => {
        if (val === null || val === undefined) return "";
        let s = String(val).replace(/"/g, '""');
        return `"${s}"`;
      };

      // [FIX] limite de exportação para evitar esgotamento de memória
      const cursor = Empresa.find(filter)
        .sort({ _id: -1 })
        .limit(MAX_EXPORT_ROWS)
        .read(READ_PREFERENCE)
        .lean()
        .cursor({ batchSize: 500 });

      let count = 0;
      for await (const doc of cursor) {
        count++;
        const est = doc.estabelecimentos?.[0] || {};
        const endereco = est.endereco || {};
        const contatos = est.contatos || {};
        const email = est.email || contatos.email || "";
        const cidadeUf = [endereco.municipio?.descricao, endereco.uf].filter(Boolean).join(" - ");
        const telefone = (Array.isArray(est.telefones) && est.telefones[0]) || contatos.telefone1 || contatos.telefone2 || "";

        res.write([
          csvEscape(est.cnpj || ""),
          csvEscape(doc.razaoSocial || ""),
          csvEscape(est.nomeFantasia || ""),
          csvEscape(email),
          csvEscape(cidadeUf),
          csvEscape(est.cnaeFiscalPrincipal?.codigo || est.cnaeFiscalPrincipalCodigo || ""),
          csvEscape(telefone),
          csvEscape(est.porte?.codigo || doc.porte?.codigo || ""),
          csvEscape(doc.natureza?.descricao || ""),
        ].join(",") + "\r\n");
      }

      // [FIX] avisa se truncado
      if (count >= MAX_EXPORT_ROWS) {
        res.setHeader("X-Truncated", "true");
        res.setHeader("X-Max-Rows", String(MAX_EXPORT_ROWS));
      }

      res.end();
    } catch (e) {
      console.error("[empresas.csv] erro:", e);
      if (!res.headersSent)
        return res.status(500).json({ error: "Erro ao exportar CSV", detail: e.message });
      else res.end();
    }
  });

  // ======= EXPORTAÇÃO XLSX =======
  app.get(
    ["/api/empresas.xlsx", "/api/empresas/export", "/empresas/export"],
    timingHeader,
    async (req, res) => {
      let p;
      try {
        p = SearchSchema.parse(req.query);
      } catch (e) {
        return res.status(400).json({ error: "Parâmetros inválidos", detail: e.message });
      }

      const filter = buildFilter(p); // [FIX] usa função centralizada

      try {
        const filename = `empresas_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.xlsx`;
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Empresas");

        sheet.addRow(["CNPJ", "RazaoSocial", "NomeFantasia", "Email", "CidadeUF", "CNAE", "Telefone", "Porte", "NaturezaJuridica"]);

        // [FIX] limite de exportação
        const cursor = Empresa.find(filter)
          .sort({ _id: -1 })
          .limit(MAX_EXPORT_ROWS)
          .read(READ_PREFERENCE)
          .lean()
          .cursor({ batchSize: 500 });

        let count = 0;
        for await (const doc of cursor) {
          count++;
          const est = doc.estabelecimentos?.[0] || {};
          const endereco = est.endereco || {};
          const contatos = est.contatos || {};
          const email = est.email || contatos.email || "";
          const cidadeUf = [endereco.municipio?.descricao, endereco.uf].filter(Boolean).join(" - ");
          const telefone = (Array.isArray(est.telefones) && est.telefones[0]) || contatos.telefone1 || contatos.telefone2 || "";

          sheet.addRow([
            est.cnpj || "",
            doc.razaoSocial || "",
            est.nomeFantasia || "",
            email,
            cidadeUf,
            est.cnaeFiscalPrincipal?.codigo || est.cnaeFiscalPrincipalCodigo || "",
            telefone,
            est.porte?.descricao || doc.porte?.descricao || "Desconhecido",
            doc.natureza?.descricao || "",
          ]);
        }

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Cache-Control", "no-cache");
        if (count >= MAX_EXPORT_ROWS) res.setHeader("X-Truncated", "true");

        await workbook.xlsx.write(res);
        res.end();
      } catch (e) {
        console.error("[empresas.xlsx] erro:", e);
        if (!res.headersSent)
          return res.status(500).json({ error: "Erro ao exportar XLSX", detail: e.message });
        else res.end();
      }
    }
  );

  // ======= SUGGESTIONS =======
  app.get("/api/suggest/porte", async (req, res) => {
    const raw = (req.query.q ?? "").toString();
    const q = raw.trim().toUpperCase();
    const base = [
      { codigo: "1", descricao: "NÃO INFORMADO" },
      { codigo: "2", descricao: "MICRO EMPRESA" },
      { codigo: "3", descricao: "EMPRESA DE PEQUENO PORTE" },
      { codigo: "5", descricao: "DEMAIS" },
    ];
    if (!q) {
      return res.json(base.map((p) => ({ value: p.codigo, label: `${p.codigo} - ${p.descricao}` })));
    }
    const qSemEspaco = q.replace(/\s+/g, "");
    const filtered = base.filter((p) => {
      const cod = String(p.codigo).toUpperCase();
      const desc = String(p.descricao).toUpperCase();
      return cod.startsWith(q) || desc.includes(q) || desc.replace(/\s+/g, "").includes(qSemEspaco);
    });
    return res.json(filtered.map((p) => ({ value: p.codigo, label: `${p.codigo} - ${p.descricao}` })));
  });

  app.get("/api/suggest/natureza", async (req, res) => {
    const q = (req.query.q || "").trim();
    const match = q ? new RegExp(reEscape(q), "i") : null;
    try {
      const filter = match
        ? { $or: [{ "natureza.codigo": match }, { "natureza.descricao": match }] }
        : {};
      const results = await Empresa.aggregate([
        { $match: filter },
        { $group: { _id: { codigo: "$natureza.codigo", descricao: "$natureza.descricao" } } },
        { $project: { _id: 0, codigo: "$_id.codigo", descricao: "$_id.descricao" } },
        { $limit: 20 },
      ]);
      res.json(results.map((r) => ({ value: r.codigo, label: `${r.codigo} - ${r.descricao}` })));
    } catch (e) {
      console.error("[suggest/natureza] erro:", e);
      res.status(500).json([]);
    }
  });

  app.get("/api/suggest/cnae", async (req, res) => {
    const q = (req.query.q || "").trim();
    if (!q) return res.json([]);
    const match = new RegExp(reEscape(q), "i");
    try {
      const results = await Empresa.aggregate([
        { $unwind: "$estabelecimentos" },
        {
          $match: {
            $or: [
              { "estabelecimentos.cnaeFiscalPrincipal.codigo": match },
              { "estabelecimentos.cnaeFiscalPrincipal.descricao": match },
            ],
          },
        },
        {
          $group: {
            _id: {
              codigo: "$estabelecimentos.cnaeFiscalPrincipal.codigo",
              descricao: "$estabelecimentos.cnaeFiscalPrincipal.descricao",
            },
          },
        },
        { $project: { _id: 0, codigo: "$_id.codigo", descricao: "$_id.descricao" } },
        { $limit: 20 },
      ]);
      res.json(results.map((r) => ({ value: r.codigo, label: `${r.codigo} - ${r.descricao}` })));
    } catch (e) {
      console.error("[suggest/cnae] erro:", e);
      res.status(500).json([]);
    }
  });

  app.get("/api/suggest/uf", async (_req, res) => {
    try {
      const results = await Empresa.aggregate([
        { $unwind: "$estabelecimentos" },
        { $group: { _id: "$estabelecimentos.endereco.uf" } },
        { $match: { _id: { $ne: null } } },
        { $project: { _id: 0, uf: "$_id" } },
        { $sort: { uf: 1 } },
        { $limit: 30 },
      ]);
      res.json(results.map((r) => ({ value: r.uf, label: r.uf })));
    } catch (e) {
      console.error("[suggest/uf] erro:", e);
      res.status(500).json([]);
    }
  });

  app.get("/api/suggest/cidade", async (req, res) => {
    const q = (req.query.q || "").trim();
    const uf = (req.query.uf || "").trim().toUpperCase();
    if (!q && !uf) return res.json([]);
    const match = q ? new RegExp(reEscape(q), "i") : null;
    try {
      const pipeline = [{ $unwind: "$estabelecimentos" }];
      const matchStage = {};
      if (match) matchStage["estabelecimentos.endereco.municipio.descricao"] = match;
      if (uf) matchStage["estabelecimentos.endereco.uf"] = uf;
      pipeline.push({ $match: matchStage });
      pipeline.push({
        $group: {
          _id: {
            cidade: "$estabelecimentos.endereco.municipio.descricao",
            uf: "$estabelecimentos.endereco.uf",
          },
        },
      });
      pipeline.push({ $project: { _id: 0, cidade: "$_id.cidade", uf: "$_id.uf" } });
      pipeline.push({ $sort: { cidade: 1 } });
      pipeline.push({ $limit: 30 });

      const results = await Empresa.aggregate(pipeline);
      res.json(
        results.map((r) => ({
          value: `${r.cidade} - ${r.uf}`,
          label: `${r.cidade} - ${r.uf}`,
        }))
      );
    } catch (e) {
      console.error("[suggest/cidade] erro:", e);
      res.status(500).json([]);
    }
  });

  app.get("/api/suggest/nome", async (req, res) => {
    const q = (req.query.q || "").trim();
    const match = q ? new RegExp(reEscape(q), "i") : null;
    try {
      const cond = match ? { razaoSocial: match } : {};
      const results = await Empresa.aggregate([
        { $match: cond },
        { $project: { _id: 0, nome: "$razaoSocial" } },
        { $limit: 30 },
      ]);
      res.json(results.map((r) => ({ nome: r.nome })));
    } catch (e) {
      console.error("[suggest/nome] erro:", e);
      res.status(500).json([]);
    }
  });

  // ======= DETALHE =======
  app.get("/api/empresas/:cnpj", timingHeader, async (req, res) => {
    const cnpj = (req.params.cnpj || "").replace(/\D/g, "");
    if (!/^\d{14}$/.test(cnpj))
      return res.status(400).json({ error: "CNPJ inválido" });
    try {
      const doc = await Empresa.findOne({ "estabelecimentos.cnpj": cnpj })
        .read(READ_PREFERENCE)
        .lean()
        .maxTimeMS(2000)
        .exec();
      if (!doc) return res.status(404).json({ error: "Empresa não encontrada" });
      res.json(doc);
    } catch (e) {
      console.error("[empresa detalhe] erro:", e);
      res.status(500).json({ error: "Erro ao buscar", detail: e.message });
    }
  });

  const PORT = Number(process.env.PORT || 3001);
  app.listen(PORT, () => {
    console.log(`✅ API ativa em http://localhost:${PORT}`);
  });
})();
