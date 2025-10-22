// src/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { z } from "zod";
import { connectMongo } from "./db.js";
import Empresa from "./models/Empresa.js";
import { parseCapitalSocial } from "./filters.js";

mongoose.set("autoIndex", process.env.NODE_ENV !== "production");

// ======= CONFIG =======
const READ_PREFERENCE = process.env.MONGO_READ_PREFERENCE || "primaryPreferred";
const DEFAULT_PAGE_SIZE = 10;
const MAX_TIME_MS_PRIMARY = Number(process.env.MAX_TIME_MS || 2000);
const MAX_TIME_MS_RETRY = Number(process.env.MAX_TIME_MS_RETRY || 4000);

const INATIVA_CODES = (process.env.INATIVA_CODES || "1,3,4,8,9")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ======= HELPERS =======
const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const like = (s) => new RegExp(reEscape(String(s)), "i");

function likeField(field, val) {
  return {
    $or: [
      { [field]: like(val) },
      {
        $expr: {
          $regexMatch: {
            input: { $toString: `$${field}` },
            regex: reEscape(String(val)),
            options: "i",
          },
        },
      },
    ],
  };
}

function encodeCursor(doc) {
  return Buffer.from(JSON.stringify({ id: String(doc._id) })).toString(
    "base64"
  );
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
  cnpj: z.string().optional(), // ✅ ADICIONE ESTA LINHA
  cnaePrincipal: z.string().optional(),
  buscarCnaeSecundario: z.union([z.literal("1"), z.literal("0")]).optional(),
  localizacao: z.string().optional(),
  situacao: z.string().optional(),
  tipo: z.string().optional(),
  naturezaJuridica: z.string().optional(),
  porte: z.string().optional(),
  capitalSocial: z.string().optional(),
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

// =================== APP ===================
(async () => {
  await connectMongo();

  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: true }));

  // HEALTH
  app.get("/health", async (_req, res) => {
    try {
      await Empresa.findOne({}, { _id: 1 })
        .read(READ_PREFERENCE)
        .maxTimeMS(1000)
        .lean();
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
      return res
        .status(400)
        .json({ error: "Parâmetros inválidos", detail: e.message });
    }

    const limit = p.pageSize || DEFAULT_PAGE_SIZE;
    const and = [];
    const or = [];

    // Razão social / nome fantasia
    if (p.nome) or.push({ razaoSocial: like(p.nome) });
    // ✅ Filtro por CNPJ
    if (p.cnpj) or.push({ "estabelecimentos.cnpj": like(p.cnpj) });

    if (p.nomeFantasia)
      or.push({ "estabelecimentos.nomeFantasia": like(p.nomeFantasia) });

    // Situação
    if (p.situacao) {
      const sit = p.situacao.toUpperCase();
      if (sit === "ATIVA") {
        or.push({ "estabelecimentos.situacaoCadastral": like("04") });
      } else if (sit === "INATIVA") {
        or.push({
          "estabelecimentos.situacaoCadastral": {
            $in: INATIVA_CODES.map((c) => like(c)),
          },
        });
      } else {
        or.push({ "estabelecimentos.situacaoCadastral": like(sit) });
      }
    }

    // Porte
    if (p.porte) {
      or.push(
        { "porte.descricao": like(p.porte) },
        { "porte.codigo": like(p.porte) }
      );
    }

    // Natureza jurídica
    if (p.naturezaJuridica) {
      or.push(
        { "natureza.codigo": like(p.naturezaJuridica) },
        { "natureza.descricao": like(p.naturezaJuridica) }
      );
    }

    // CNAE principal e secundário
    // CNAE principal
    if (p.cnaePrincipal) {
      const rx = like(p.cnaePrincipal);
      or.push(
        { "estabelecimentos.cnaeFiscalPrincipal.codigo": rx },
        { "estabelecimentos.cnaeFiscalPrincipal.descricao": rx }
      );
    }

    // CNAE secundário (independente do flag buscarCnaeSecundario)
    if (p.buscarCnaeSecundario === "1" && p.cnaePrincipal) {
      const rxSec = like(p.cnaePrincipal);
      or.push({ "estabelecimentos.cnaesSecundariosCodigos": rxSec });
    }

    // Localização (cidade, UF, CEP)
    // ===== Localização (corrigido e robusto) =====
    if (p.localizacao) {
      const raw = p.localizacao.trim();
      const hasDash = raw.includes("-");
      const isUf = /^[A-Za-z]{2}$/.test(raw);
      const isCep = /^\d{5}-?\d{3}$/.test(raw);

      if (hasDash) {
        // "Cidade - UF"
        const [cidade, uf] = raw.split("-").map((s) => s.trim().toUpperCase());
        and.push({
          estabelecimentos: {
            $elemMatch: {
              "endereco.municipio.descricao": new RegExp(cidade, "i"),
              "endereco.uf": uf,
            },
          },
        });
      } else if (isUf) {
        // Apenas UF
        and.push({
          estabelecimentos: {
            $elemMatch: {
              "endereco.uf": raw.toUpperCase(),
            },
          },
        });
      } else if (isCep) {
        // CEP
        and.push({
          estabelecimentos: {
            $elemMatch: {
              "endereco.cep": raw.replace(/\D/g, ""),
            },
          },
        });
      } else {
        // Apenas cidade
        and.push({
          estabelecimentos: {
            $elemMatch: {
              "endereco.municipio.descricao": new RegExp(raw, "i"),
            },
          },
        });
      }
    }

    // Capital social
    const cap = parseCapitalSocial(p.capitalSocial) || {};
    if (Object.keys(cap).length) and.push(cap);

    if (or.length) and.push({ $or: or });
    const filter = and.length ? { $and: and } : {};

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
      const docs = await Empresa.find(finalFilter)
        .sort(sortSpec)
        .limit(limit + 1)
        .read(READ_PREFERENCE)
        .collation({ locale: "pt", strength: 1 })
        .lean()
        .maxTimeMS(MAX_TIME_MS_PRIMARY)
        .exec();

      const hasNextPage = docs.length > limit;
      const items = hasNextPage ? docs.slice(0, limit) : docs;
      const nextCursor = hasNextPage
        ? encodeCursor(items[items.length - 1])
        : null;

      // ✅ Inclui o total esperado pelo front-end
      res.json({
        items,
        total: items.length,
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

  const and = [];
  const or = [];

  // Filtros iguais ao /api/empresas
  if (p.nome) or.push({ razaoSocial: like(p.nome) });
  if (p.nomeFantasia)
    or.push({ "estabelecimentos.nomeFantasia": like(p.nomeFantasia) });
  if (p.cnpj)
    or.push({ "estabelecimentos.cnpj": like(p.cnpj) });

  if (p.cnaePrincipal) {
    const rx = like(p.cnaePrincipal);
    or.push(
      { "estabelecimentos.cnaeFiscalPrincipal.codigo": rx },
      { "estabelecimentos.cnaeFiscalPrincipal.descricao": rx }
    );
  }

  if (p.localizacao)
    or.push(
      likeField("estabelecimentos.endereco.uf", p.localizacao),
      likeField("estabelecimentos.endereco.municipio.descricao", p.localizacao),
      likeField("estabelecimentos.endereco.cep", p.localizacao)
    );

  if (or.length) and.push({ $or: or });
  const filter = and.length ? { $and: and } : {};

  const filename = `empresas_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-cache");
  res.write("\uFEFF"); // BOM UTF-8 para Excel

  const header = ["CNPJ", "RazaoSocial", "NomeFantasia", "Localidade", "CNAE", "Status"];
  res.write(header.join(",") + "\r\n");

  try {
    const cursor = Empresa.find(filter).read(READ_PREFERENCE).lean().cursor();

    for await (const doc of cursor) {
      const est = doc.estabelecimentos?.[0] || {};
      const line = [
        est.cnpj || "",
        `"${(doc.razaoSocial || "").replace(/"/g, '""')}"`,
        `"${(est.nomeFantasia || "").replace(/"/g, '""')}"`,
        `"${(est.endereco?.municipio?.descricao || "")} - ${est.endereco?.uf || ""}"`,
        est.cnaeFiscalPrincipal?.codigo || "",
        est.situacaoCadastral || "",
      ].join(",");
      res.write(line + "\r\n");
    }

    res.end();
  } catch (e) {
    console.error("[empresas.csv] erro:", e);
    if (!res.headersSent)
      return res.status(500).json({ error: "Erro ao exportar CSV", detail: e.message });
    else res.end();
  }
});


  // ======= SUGGESTIONS =======
  function reEscapeLocal(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  app.get("/suggest/porte", async (req, res) => {
    const q = (req.query.q || "").trim();
    const match = q ? new RegExp(reEscapeLocal(q), "i") : null;
    try {
      const filter = match
        ? { $or: [{ "porte.codigo": match }, { "porte.descricao": match }] }
        : {};
      const results = await Empresa.aggregate([
        { $match: filter },
        {
          $group: {
            _id: { codigo: "$porte.codigo", descricao: "$porte.descricao" },
          },
        },
        {
          $project: {
            _id: 0,
            codigo: "$_id.codigo",
            descricao: "$_id.descricao",
          },
        },
        { $limit: 20 },
      ]);
      res.json(
        results.map((r) => ({
          value: r.codigo,
          label: `${r.codigo} - ${r.descricao}`,
        }))
      );
    } catch (e) {
      console.error("[suggest/porte] erro:", e);
      res.status(500).json([]);
    }
  });

  app.get("/suggest/natureza", async (req, res) => {
    const q = (req.query.q || "").trim();
    const match = q ? new RegExp(reEscapeLocal(q), "i") : null;
    try {
      const filter = match
        ? {
            $or: [
              { "natureza.codigo": match },
              { "natureza.descricao": match },
            ],
          }
        : {};
      const results = await Empresa.aggregate([
        { $match: filter },
        {
          $group: {
            _id: {
              codigo: "$natureza.codigo",
              descricao: "$natureza.descricao",
            },
          },
        },
        {
          $project: {
            _id: 0,
            codigo: "$_id.codigo",
            descricao: "$_id.descricao",
          },
        },
        { $limit: 20 },
      ]);
      res.json(
        results.map((r) => ({
          value: r.codigo,
          label: `${r.codigo} - ${r.descricao}`,
        }))
      );
    } catch (e) {
      console.error("[suggest/natureza] erro:", e);
      res.status(500).json([]);
    }
  });

  app.get("/suggest/cnae", async (req, res) => {
    const q = (req.query.q || "").trim();
    const match = q ? new RegExp(reEscapeLocal(q), "i") : null;
    try {
      const filter = match
        ? {
            $or: [
              { "estabelecimentos.cnaeFiscalPrincipal.codigo": match },
              { "estabelecimentos.cnaeFiscalPrincipal.descricao": match },
            ],
          }
        : {};
      const results = await Empresa.aggregate([
        { $match: filter },
        {
          $group: {
            _id: {
              codigo: "$estabelecimentos.cnaeFiscalPrincipal.codigo",
              descricao: "$estabelecimentos.cnaeFiscalPrincipal.descricao",
            },
          },
        },
        {
          $project: {
            _id: 0,
            codigo: "$_id.codigo",
            descricao: "$_id.descricao",
          },
        },
        { $limit: 20 },
      ]);
      res.json(
        results.map((r) => ({
          value: r.codigo,
          label: `${r.codigo} - ${r.descricao}`,
        }))
      );
    } catch (e) {
      console.error("[suggest/cnae] erro:", e);
      res.status(500).json([]);
    }
  });

  app.get("/suggest/uf", async (req, res) => {
    try {
      const results = await Empresa.aggregate([
        { $group: { _id: "$estabelecimentos.endereco.uf" } },
        { $project: { _id: 0, uf: "$_id" } },
        { $limit: 30 },
      ]);
      res.json(
        results.filter((r) => r.uf).map((r) => ({ value: r.uf, label: r.uf }))
      );
    } catch (e) {
      console.error("[suggest/uf] erro:", e);
      res.status(500).json([]);
    }
  });

  app.get("/suggest/cidade", async (req, res) => {
    const q = (req.query.q || "").trim();
    const uf = (req.query.uf || "").trim().toUpperCase();
    const match = q ? new RegExp(reEscapeLocal(q), "i") : null;

    const cond = {};
    if (match) cond["estabelecimentos.endereco.municipio.descricao"] = match;
    if (uf) cond["estabelecimentos.endereco.uf"] = uf;

    try {
      const results = await Empresa.aggregate([
        { $match: cond },
        {
          $group: {
            _id: {
              cidade: "$estabelecimentos.endereco.municipio.descricao",
              uf: "$estabelecimentos.endereco.uf",
            },
          },
        },
        { $project: { _id: 0, cidade: "$_id.cidade", uf: "$_id.uf" } },
        { $limit: 30 },
      ]);
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

  // ======= DETALHE =======
  app.get("/api/empresas/:cnpj", timingHeader, async (req, res) => {
    const cnpj = (req.params.cnpj || "").replace(/\D/g, "");
    if (!/^\d{14}$/.test(cnpj))
      return res.status(400).json({ error: "CNPJ inválido" });

    try {
      const doc = await Empresa.findOne({ cnpj })
        .read(READ_PREFERENCE)
        .lean()
        .maxTimeMS(2000)
        .exec();

      if (!doc)
        return res.status(404).json({ error: "Empresa não encontrada" });
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
