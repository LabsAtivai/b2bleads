// src/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { z } from "zod";
import ExcelJS from "exceljs";

import { connectMongo } from "./db.js";
import Empresa from "./models/Empresa.js";
import { parseCapitalSocial } from "./filters.js";

mongoose.set("autoIndex", process.env.NODE_ENV !== "production");

// ======= CONFIG =======
const READ_PREFERENCE =
  process.env.MONGO_READ_PREFERENCE || "primaryPreferred";
const DEFAULT_PAGE_SIZE = 10;
const MAX_TIME_MS_PRIMARY = Number(process.env.MAX_TIME_MS || 2000);
const MAX_TIME_MS_RETRY = Number(process.env.MAX_TIME_MS_RETRY || 8000);

const INATIVA_CODES = (process.env.INATIVA_CODES || "1,3,4,8,9")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ======= HELPERS =======
const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const like = (s) => new RegExp(reEscape(String(s)), "i");

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

// ======= PORTE HELPER =======
function buildPorteFilter(porteInput) {
  if (!porteInput) return null;

  const porte = String(porteInput).trim().toUpperCase();

  // Tabela oficial de porte:
  // 1  - NÃO INFORMADO
  // 2  - MICRO EMPRESA
  // 03 - EMPRESA DE PEQUENO PORTE
  // 05 - DEMAIS
  const map = {
    "1": ["1", "01", "NÃO INFORMADO"],
    "2": ["2", "02", "MICRO EMPRESA"],
    "3": ["3", "03", "EMPRESA DE PEQUENO PORTE"],
    "5": ["5", "05", "DEMAIS"],
  };

  let keys = [];

  // Se vier "1", "2", "3", "5"
  if (map[porte]) {
    keys = map[porte];
  } else {
    // Se vier "MICRO", "DEMAIS", etc.
    Object.values(map).forEach(arr => {
      if (arr.some(v => v.includes(porte))) {
        keys.push(...arr);
      }
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
  situacao: z.string().optional(),
  tipo: z.string().optional(),
  naturezaJuridica: z.string().optional(),
  porte: z.string().optional(),
  capitalSocial: z.string().optional(),
  email: z.string().optional(),
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

    // ===== Razão social / nome fantasia =====
    if (p.nome) {
      or.push({ razaoSocial: like(p.nome) });
    }

    if (p.nomeFantasia) {
      or.push({ "estabelecimentos.nomeFantasia": like(p.nomeFantasia) });
    }

    // ===== CNPJ =====
    if (p.cnpj) {
      const cnpjDigits = p.cnpj.replace(/\D/g, "");
      if (cnpjDigits.length === 14) {
        or.push({ "estabelecimentos.cnpj": cnpjDigits });
      } else if (cnpjDigits.length > 0) {
        or.push({
          "estabelecimentos.cnpj": new RegExp(reEscape(cnpjDigits)),
        });
      }
    }

    // ===== Email (flatten + legado) =====
    if (p.email) {
      const rx = like(p.email);
      or.push(
        { "estabelecimentos.email": rx },
        { "estabelecimentos.contatos.email": rx }
      );
    }

    // ===== Situação cadastral =====
    if (p.situacao) {
      const sit = p.situacao.toUpperCase();
      if (sit === "ATIVA") {
        // na base nova: "02"
        or.push({ "estabelecimentos.situacaoCadastral": "02" });
      } else if (sit === "INATIVA") {
        or.push({
          "estabelecimentos.situacaoCadastral": {
            $in: INATIVA_CODES,
          },
        });
      } else {
        or.push({ "estabelecimentos.situacaoCadastral": like(sit) });
      }
    }

    // ===== Porte =====
    if (p.porte) {
      const porteFilter = buildPorteFilter(p.porte);
      if (porteFilter) {
        or.push(porteFilter);
      }
    }

    // ===== Natureza jurídica =====
    if (p.naturezaJuridica) {
      const rx = like(p.naturezaJuridica);
      or.push({ "natureza.codigo": rx }, { "natureza.descricao": rx });
    }

    // ===== CNAE principal (aceita "4781400", "47.81-4-00", "47.81/4-00" ou nome) =====
    if (p.cnaePrincipal) {
      const rawCnae = p.cnaePrincipal.trim();
      const digits = rawCnae.replace(/\D/g, ""); // remove ".", "-", "/"
      const rx = like(rawCnae);

      // se tiver pelo menos 4 dígitos, tratamos como código
      if (digits.length >= 4) {
        or.push({ "estabelecimentos.cnaeFiscalPrincipalCodigo": digits });
      }

      // também busca no objeto principal (código e descrição)
      or.push(
        { "estabelecimentos.cnaeFiscalPrincipal.codigo": rx },
        { "estabelecimentos.cnaeFiscalPrincipal.descricao": rx }
      );
    }

    // ===== CNAE secundário (opcional) =====
    if (p.buscarCnaeSecundario === "1" && p.cnaePrincipal) {
      const rawCnae = p.cnaePrincipal.trim();
      const digits = rawCnae.replace(/\D/g, "");
      const rxSec = like(rawCnae);

      if (digits.length >= 4) {
        or.push({ "estabelecimentos.cnaesSecundariosCodigos": digits });
      } else {
        or.push({ "estabelecimentos.cnaesSecundariosCodigos": rxSec });
      }
    }

    // ===== Localização (cidade, UF, CEP) =====
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
              "endereco.municipio.descricao": new RegExp(
                reEscape(cidade),
                "i"
              ),
              "endereco.uf": uf.toUpperCase(),
            },
          },
        });
      } else if (isUf) {
        and.push({
          estabelecimentos: {
            $elemMatch: {
              "endereco.uf": raw.toUpperCase(),
            },
          },
        });
      } else if (isCep) {
        const cepDigits = raw.replace(/\D/g, "");
        and.push({
          estabelecimentos: {
            $elemMatch: {
              "endereco.cep": cepDigits,
            },
          },
        });
      } else {
        and.push({
          estabelecimentos: {
            $elemMatch: {
              "endereco.municipio.descricao": new RegExp(
                reEscape(raw),
                "i"
              ),
            },
          },
        });
      }
    }

    // ===== Capital social =====
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
      async function runFind() {
        try {
          // tentativa rápida
          return await Empresa.find(finalFilter)
            .sort(sortSpec)
            .limit(limit + 1)
            .read(READ_PREFERENCE)
            .lean()
            .maxTimeMS(MAX_TIME_MS_PRIMARY)
            .exec();
        } catch (e) {
          if (e.code === 50) {
            console.warn(
              "[/api/empresas] MaxTimeMSExpired, retry com secondaryPreferred..."
            );
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

      // countDocuments com o filtro base (sem cursor) + dados da página
      const [docs, total] = await Promise.all([
        runFind(),
        Empresa.countDocuments(filter)
          .read(READ_PREFERENCE)
          .maxTimeMS(MAX_TIME_MS_RETRY)
          .exec()
          .catch((err) => {
            console.warn(
              "[/api/empresas] countDocuments falhou:",
              err.message
            );
            return undefined;
          }),
      ]);

      const hasNextPage = docs.length > limit;
      const items = hasNextPage ? docs.slice(0, limit) : docs;
      const nextCursor = hasNextPage
        ? encodeCursor(items[items.length - 1])
        : null;

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

  // ======= EXPORTAÇÃO CSV (opcional, mantém compat) =======
  app.get("/api/empresas.csv", timingHeader, async (req, res) => {
    let p;
    try {
      p = SearchSchema.parse(req.query);
    } catch (e) {
      return res
        .status(400)
        .json({ error: "Parâmetros inválidos", detail: e.message });
    }

    const and = [];
    const or = [];

    if (p.nome) {
      or.push({ razaoSocial: like(p.nome) });
    }

    if (p.nomeFantasia) {
      or.push({ "estabelecimentos.nomeFantasia": like(p.nomeFantasia) });
    }

    if (p.cnpj) {
      const cnpjDigits = p.cnpj.replace(/\D/g, "");
      if (cnpjDigits.length === 14) {
        or.push({ "estabelecimentos.cnpj": cnpjDigits });
      } else if (cnpjDigits.length > 0) {
        or.push({
          "estabelecimentos.cnpj": new RegExp(reEscape(cnpjDigits)),
        });
      }
    }

    if (p.email) {
      const rx = like(p.email);
      or.push(
        { "estabelecimentos.email": rx },
        { "estabelecimentos.contatos.email": rx }
      );
    }

    if (p.cnaePrincipal) {
      const rawCnae = p.cnaePrincipal.trim();
      const digits = rawCnae.replace(/\D/g, "");
      const rx = like(rawCnae);

      if (digits.length >= 4) {
        or.push({ "estabelecimentos.cnaeFiscalPrincipalCodigo": digits });
      }

      or.push(
        { "estabelecimentos.cnaeFiscalPrincipal.codigo": rx },
        { "estabelecimentos.cnaeFiscalPrincipal.descricao": rx }
      );
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
              "endereco.municipio.descricao": new RegExp(
                reEscape(cidade),
                "i"
              ),
              "endereco.uf": uf.toUpperCase(),
            },
          },
        });
      } else if (isUf) {
        and.push({
          estabelecimentos: {
            $elemMatch: {
              "endereco.uf": raw.toUpperCase(),
            },
          },
        });
      } else if (isCep) {
        const cepDigits = raw.replace(/\D/g, "");
        and.push({
          estabelecimentos: {
            $elemMatch: {
              "endereco.cep": cepDigits,
            },
          },
        });
      } else {
        and.push({
          estabelecimentos: {
            $elemMatch: {
              "endereco.municipio.descricao": new RegExp(
                reEscape(raw),
                "i"
              ),
            },
          },
        });
      }
    }

    if (p.situacao) {
      const sit = p.situacao.toUpperCase();
      if (sit === "ATIVA") {
        or.push({ "estabelecimentos.situacaoCadastral": "02" });
      } else if (sit === "INATIVA") {
        or.push({
          "estabelecimentos.situacaoCadastral": {
            $in: INATIVA_CODES,
          },
        });
      } else {
        or.push({ "estabelecimentos.situacaoCadastral": like(sit) });
      }
    }

    if (or.length) and.push({ $or: or });
    const filter = and.length ? { $and: and } : {};

    try {
      const filename = `empresas_${new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-")}.csv`;

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
      res.setHeader("Cache-Control", "no-cache");
      res.write("\uFEFF"); // BOM UTF-8 p/ Excel

      const header = [
        "CNPJ",
        "RazaoSocial",
        "NomeFantasia",
        "Email",
        "CidadeUF",
        "CNAE",
        "Telefone",
        "Porte",
        "NaturezaJuridica",
      ];
      res.write(header.join(",") + "\r\n");

      const csvEscape = (val) => {
        if (val === null || val === undefined) return "";
        let s = String(val).replace(/"/g, '""');
        return `"${s}"`;
      };

      const cursor = Empresa.find(filter)
        .sort({ _id: -1 })
        .read(READ_PREFERENCE)
        .lean()
        .cursor({ batchSize: 500 });

      for await (const doc of cursor) {
        const est = doc.estabelecimentos?.[0] || {};
        const endereco = est.endereco || {};
        const contatos = est.contatos || {};
        const email = est.email || contatos.email || "";

        const cidadeUf = [
          endereco.municipio?.descricao || "",
          endereco.uf || "",
        ]
          .filter(Boolean)
          .join(" - ");

        const telefone =
          (Array.isArray(est.telefones) && est.telefones[0]) ||
          contatos.telefone1 ||
          contatos.telefone2 ||
          "";

        const line = [
          csvEscape(est.cnpj || ""),
          csvEscape(doc.razaoSocial || ""),
          csvEscape(est.nomeFantasia || ""),
          csvEscape(email),
          csvEscape(cidadeUf),
          csvEscape(
            est.cnaeFiscalPrincipal?.codigo || est.cnaeFiscalPrincipalCodigo || ""
          ),
          csvEscape(telefone),
          csvEscape(est.porte?.codigo || doc.porte?.codigo || ""),
          csvEscape(doc.natureza?.descricao || ""),
        ].join(",");

        res.write(line + "\r\n");
      }

      res.end();
    } catch (e) {
      console.error("[empresas.csv] erro:", e);
      if (!res.headersSent)
        return res
          .status(500)
          .json({ error: "Erro ao exportar CSV", detail: e.message });
      else res.end();
    }
  });

  // ======= EXPORTAÇÃO XLSX (principal) =======
  app.get(
    ["/api/empresas.xlsx", "/api/empresas/export", "/empresas/export"],
    timingHeader,
    async (req, res) => {
      let p;
      try {
        p = SearchSchema.parse(req.query);
      } catch (e) {
        return res
          .status(400)
          .json({ error: "Parâmetros inválidos", detail: e.message });
      }

      const and = [];
      const or = [];

      if (p.nome) {
        or.push({ razaoSocial: like(p.nome) });
      }

      if (p.nomeFantasia) {
        or.push({ "estabelecimentos.nomeFantasia": like(p.nomeFantasia) });
      }

      if (p.cnpj) {
        const cnpjDigits = p.cnpj.replace(/\D/g, "");
        if (cnpjDigits.length === 14) {
          or.push({ "estabelecimentos.cnpj": cnpjDigits });
        } else if (cnpjDigits.length > 0) {
          or.push({
            "estabelecimentos.cnpj": new RegExp(reEscape(cnpjDigits)),
          });
        }
      }

      if (p.email) {
        const rx = like(p.email);
        or.push(
          { "estabelecimentos.email": rx },
          { "estabelecimentos.contatos.email": rx }
        );
      }

      if (p.cnaePrincipal) {
        const rawCnae = p.cnaePrincipal.trim();
        const digits = rawCnae.replace(/\D/g, "");
        const rx = like(rawCnae);

        if (digits.length >= 4) {
          or.push({ "estabelecimentos.cnaeFiscalPrincipalCodigo": digits });
        }

        or.push(
          { "estabelecimentos.cnaeFiscalPrincipal.codigo": rx },
          { "estabelecimentos.cnaeFiscalPrincipal.descricao": rx }
        );
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
                "endereco.municipio.descricao": new RegExp(
                  reEscape(cidade),
                  "i"
                ),
                "endereco.uf": uf.toUpperCase(),
              },
            },
          });
        } else if (isUf) {
          and.push({
            estabelecimentos: {
              $elemMatch: {
                "endereco.uf": raw.toUpperCase(),
              },
            },
          });
        } else if (isCep) {
          const cepDigits = raw.replace(/\D/g, "");
          and.push({
            estabelecimentos: {
              $elemMatch: {
                "endereco.cep": cepDigits,
              },
            },
          });
        } else {
          and.push({
            estabelecimentos: {
              $elemMatch: {
                "endereco.municipio.descricao": new RegExp(
                  reEscape(raw),
                  "i"
                ),
              },
            },
          });
        }
      }

      if (p.situacao) {
        const sit = p.situacao.toUpperCase();
        if (sit === "ATIVA") {
          or.push({ "estabelecimentos.situacaoCadastral": "02" });
        } else if (sit === "INATIVA") {
          or.push({
            "estabelecimentos.situacaoCadastral": {
              $in: INATIVA_CODES,
            },
          });
        } else {
          or.push({ "estabelecimentos.situacaoCadastral": like(sit) });
        }
      }

      // ===== Porte =====
      if (p.porte) {
        const porteFilter = buildPorteFilter(p.porte);
        if (porteFilter) {
          or.push(porteFilter);
        }
      }

      if (or.length) and.push({ $or: or });
      const filter = and.length ? { $and: and } : {};

      try {
        const filename = `empresas_${new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/[:T]/g, "-")}.xlsx`;

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Empresas");

        const header = [
          "CNPJ",
          "RazaoSocial",
          "NomeFantasia",
          "Email",
          "CidadeUF",
          "CNAE",
          "Telefone",
          "Porte",
          "NaturezaJuridica",
        ];
        sheet.addRow(header);

        const cursor = Empresa.find(filter)
          .sort({ _id: -1 })
          .read(READ_PREFERENCE)
          .lean()
          .cursor({ batchSize: 500 });

        for await (const doc of cursor) {
          const est = doc.estabelecimentos?.[0] || {};
          const endereco = est.endereco || {};
          const contatos = est.contatos || {};
          const email = est.email || contatos.email || "";

          const cidadeUf = [
            endereco.municipio?.descricao || "",
            endereco.uf || "",
          ]
            .filter(Boolean)
            .join(" - ");

          const telefone =
            (Array.isArray(est.telefones) && est.telefones[0]) ||
            contatos.telefone1 ||
            contatos.telefone2 ||
            "";

          sheet.addRow([
            est.cnpj || "",
            doc.razaoSocial || "",
            est.nomeFantasia || "",
            email || "",
            cidadeUf || "",
            est.cnaeFiscalPrincipal?.codigo ||
            est.cnaeFiscalPrincipalCodigo ||
            "",
            telefone || "",
            est.porte?.descricao || doc.porte?.descricao || "Desconhecido",
            doc.natureza?.descricao || "",
          ]);
        }

        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`
        );
        res.setHeader("Cache-Control", "no-cache");

        await workbook.xlsx.write(res);
        res.end();
      } catch (e) {
        console.error("[empresas.xlsx] erro:", e);
        if (!res.headersSent)
          return res
            .status(500)
            .json({ error: "Erro ao exportar XLSX", detail: e.message });
        else res.end();
      }
    }
  );



  // ======= SUGGESTIONS =======
  function reEscapeLocal(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  app.get("/suggest/porte", async (req, res) => {
    const raw = (req.query.q ?? "").toString();
    const q = raw.trim().toUpperCase();

    // Tabela fixa de portes (codigos normalizados)
    const base = [
      { codigo: "1", descricao: "NÃO INFORMADO" },
      { codigo: "2", descricao: "MICRO EMPRESA" },
      { codigo: "3", descricao: "EMPRESA DE PEQUENO PORTE" },
      { codigo: "5", descricao: "DEMAIS" },
    ];

    // Se não tiver termo nenhum, devolve tudo
    if (!q) {
      return res.json(
        base.map((p) => ({
          value: p.codigo,
          label: `${p.codigo} - ${p.descricao}`,
        }))
      );
    }

    const qSemEspaco = q.replace(/\s+/g, "");

    const filtered = base.filter((p) => {
      const cod = String(p.codigo).toUpperCase();
      const desc = String(p.descricao).toUpperCase();
      const descSemEspaco = desc.replace(/\s+/g, "");

      return (
        cod.startsWith(q) ||                 // "1", "2", "3", "5"
        desc.includes(q) ||                  // "MICRO EMPRESA" contém "MICRO" ou "MI"
        descSemEspaco.includes(qSemEspaco)   // cobre casos tipo "MICROEMPRESA"
      );
    });

    return res.json(
      filtered.map((p) => ({
        value: p.codigo,
        label: `${p.codigo} - ${p.descricao}`,
      }))
    );
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

  app.get("/suggest/uf", async (_req, res) => {
    try {
      const results = await Empresa.aggregate([
        { $group: { _id: "$estabelecimentos.endereco.uf" } },
        { $project: { _id: 0, uf: "$_id" } },
        { $limit: 30 },
      ]);
      res.json(
        results
          .filter((r) => r.uf)
          .map((r) => ({ value: r.uf, label: r.uf }))
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

  // (opcional) sugestão por nome da empresa -> usado pelo suggestNome no front
  app.get("/suggest/nome", async (req, res) => {
    const q = (req.query.q || "").trim();
    const match = q ? new RegExp(reEscapeLocal(q), "i") : null;

    try {
      const cond = match ? { razaoSocial: match } : {};
      const results = await Empresa.aggregate([
        { $match: cond },
        { $project: { _id: 0, nome: "$razaoSocial" } },
        { $limit: 30 },
      ]);
      res.json(
        results.map((r) => ({
          nome: r.nome,
        }))
      );
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
