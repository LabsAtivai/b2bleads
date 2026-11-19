/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse';
import unzipper from 'unzipper';
import { MongoClient, BSON } from 'mongodb';
import dotenv from 'dotenv';
import { buildMongoUri, getDbName } from '../src/mongoConfig.js';

dotenv.config();

/* ================= CONFIG ================= */
const DB_NAME = getDbName();
const DATA_ROOT = path.resolve(process.env.DATA_ROOT || './dados_cnpj');
const ZIPS_ROOT = path.resolve(process.env.LOCAL_ZIPS_DIR || './zips_cnpj');

const BULK = 1000;
const AGG_BATCH = Number(process.env.AGG_BATCH || 500);
const MAX_DOC_BYTES = 15 * 1024 * 1024; // limite do Mongo é 16MB

/* Contexto do período em execução (definido em runImport) */
let PERIODO = '';
let ROOT = '';
let ZIPS_DIR = '';
const stats = { descartadas: 0 };

const DIRS = {
  empresas: 'Empresas',
  estab: 'Estabelecimentos',
  socios: 'Socios',
  simples: 'Simples',
  naturezas: 'Naturezas',
  municipios: 'Municipios',
  paises: 'Paises',
  qualificacoes: 'Qualificacoes',
  cnaes: 'Cnaes',
  motivos: 'Motivos',
};

/* ========= HEADERS ========= */
const HEADERS = {
  EMPRESAS: [
    'CNPJ BÁSICO',
    'RAZÃO SOCIAL / NOME EMPRESARIAL',
    'NATUREZA JURÍDICA',
    'QUALIFICAÇÃO DO RESPONSÁVEL',
    'CAPITAL SOCIAL DA EMPRESA',
    'PORTE DA EMPRESA',
    'ENTE FEDERATIVO RESPONSÁVEL',
  ],
  ESTABELECIMENTOS: [
    'CNPJ BÁSICO', 'CNPJ ORDEM', 'CNPJ DV', 'IDENTIFICADOR MATRIZ/FILIAL', 'NOME FANTASIA',
    'SITUAÇÃO CADASTRAL', 'DATA SITUAÇÃO CADASTRAL', 'MOTIVO SITUAÇÃO CADASTRAL',
    'NOME DA CIDADE NO EXTERIOR', 'PAIS', 'DATA DE INÍCIO ATIVIDADE', 'CNAE FISCAL PRINCIPAL',
    'CNAE FISCAL SECUNDÁRIA', 'TIPO DE LOGRADOURO', 'LOGRADOURO', 'NÚMERO', 'COMPLEMENTO',
    'BAIRRO', 'CEP', 'UF', 'MUNICÍPIO', 'DDD 1', 'TELEFONE 1', 'DDD 2', 'TELEFONE 2',
    'DDD DO FAX', 'FAX', 'CORREIO ELETRÔNICO', 'SITUAÇÃO ESPECIAL', 'DATA DA SITUAÇÃO ESPECIAL',
  ],
  SOCIOS: [
    'CNPJ BÁSICO',
    'IDENTIFICADOR DE SÓCIO',
    'NOME DO SÓCIO (NO CASO PF) OU RAZÃO SOCIAL (NO CASO PJ)',
    'CNPJ/CPF DO SÓCIO',
    'QUALIFICAÇÃO DO SÓCIO',
    'DATA DE ENTRADA SOCIEDADE',
    'PAIS',
    'REPRESENTANTE LEGAL',
    'NOME DO REPRESENTANTE',
    'QUALIFICAÇÃO DO REPRESENTANTE LEGAL',
    'FAIXA ETÁRIA',
  ],
  SIMPLES: [
    'CNPJ BÁSICO', 'OPÇÃO PELO SIMPLES', 'DATA DE OPÇÃO PELO SIMPLES',
    'DATA DE EXCLUSÃO DO SIMPLES', 'OPÇÃO PELO MEI', 'DATA DE OPÇÃO PELO MEI',
    'DATA DE EXCLUSÃO DO MEI',
  ],
  DOM2: ['CÓDIGO', 'DESCRIÇÃO'],
};

/* ================= HELPERS ================= */
const ensure8 = (v) => String(v ?? '').replace(/\D/g, '').padStart(8, '0').slice(-8);
const ensure4 = (v) => String(v ?? '').replace(/\D/g, '').padStart(4, '0').slice(-4);
const ensure2 = (v) => String(v ?? '').replace(/\D/g, '').padStart(2, '0').slice(-2);
const joinCnpj = (base, ordem, dv) => ensure8(base) + ensure4(ordem) + ensure2(dv);
const clean = (s) => (s == null ? '' : String(s).trim());
const SN = (v) => (v === 'S' ? true : v === 'N' ? false : undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORTE_MAP = {
  '1': 'Não informado', '01': 'Não informado',
  '2': 'Micro Empresa', '02': 'Micro Empresa',
  '3': 'Empresa de Pequeno Porte', '03': 'Empresa de Pequeno Porte',
  '5': 'Demais', '05': 'Demais',
};

// Remove undefined de objetos aninhados (o driver gravaria null).
function compactObj(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Monta update: campos definidos em $set, campos undefined em $unset
// (um valor que sumiu na Receita deixa de existir no documento).
function buildUpdate(doc, { setOnInsert } = {}) {
  const $set = {};
  const $unset = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v === undefined) $unset[k] = '';
    else $set[k] = v;
  }
  const update = { $set };
  if (Object.keys($unset).length) update.$unset = $unset;
  if (setOnInsert) update.$setOnInsert = setOnInsert;
  return update;
}

const pLimit = (concurrency) => {
  const queue = [];
  let active = 0;
  const next = () => {
    active--;
    if (queue.length) queue.shift()();
  };
  const run = (fn, resolve, reject) => {
    active++;
    Promise.resolve(fn())
      .then((v) => { resolve(v); next(); })
      .catch((e) => { reject(e); next(); });
  };
  return (fn) =>
    new Promise((res, rej) => {
      const task = () => run(fn, res, rej);
      active < concurrency ? task() : queue.push(task);
    });
};

/* =============== RETRY =============== */
function isRetryableError(err) {
  const msg = `${err?.message || ''} ${err?.errorResponse?.message || ''}`.toLowerCase();
  const patterns = [
    'econnreset', 'network', 'etimedout', 'timeout', 'timed out', 'poolcleared',
    'poolrequstedretry', 'interrupted', 'socket', 'connection closed',
    'topology was destroyed', 'not primary', 'notwritableprimary',
  ];
  if (patterns.some((p) => msg.includes(p))) return true;
  if (err?.codeName === 'NetworkTimeout') return true;
  if (err?.name === 'MongoNetworkError' || err?.name === 'MongoNetworkTimeoutError') return true;
  if (err?.errorLabels?.includes?.('RetryableWriteError')) return true;
  return false;
}

// Repete só erros transitórios; qualquer outro erro propaga imediatamente.
async function withRetry(fn, { max = 8, label = 'operação' } = {}) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || tentativa >= max) throw err;
      const wait = Math.min(tentativa * 5, 60);
      console.warn(`${label}: erro transitório (${err.message}). Tentativa ${tentativa}/${max}, aguardando ${wait}s`);
      await sleep(wait * 1000);
    }
  }
}

async function bulkWriteWithRetry(col, ops) {
  const batch = ops.splice(0);
  if (!batch.length) return;
  await withRetry(() => col.bulkWrite(batch, { ordered: false }), { label: `bulkWrite ${col.collectionName}` });
}

/* =============== EXTRAÇÃO LOCAL DOS ZIPS =============== */
const routeFor = (fileName) => {
  const f = fileName.toLowerCase();
  if (f.includes('empresa')) return DIRS.empresas;
  if (f.includes('estabelec')) return DIRS.estab;
  if (f.includes('socio')) return DIRS.socios;
  if (f.includes('simples')) return DIRS.simples;
  if (f.includes('natureza')) return DIRS.naturezas;
  if (f.includes('municipio')) return DIRS.municipios;
  if (f.includes('pais')) return DIRS.paises;
  if (f.includes('qualificacao')) return DIRS.qualificacoes;
  if (f.includes('cnae')) return DIRS.cnaes;
  if (f.includes('motivo')) return DIRS.motivos;
  return '';
};

async function extractAllLocalZips() {
  if (!fs.existsSync(ZIPS_DIR)) {
    throw new Error(`Pasta com ZIPs não encontrada: ${ZIPS_DIR}`);
  }
  const zipFiles = fs.readdirSync(ZIPS_DIR)
    .filter((f) => /\.zip$/i.test(f))
    .map((f) => path.join(ZIPS_DIR, f));
  if (zipFiles.length === 0) throw new Error(`Nenhum arquivo .zip em ${ZIPS_DIR}`);

  // Destino limpo: nunca misturar CSVs de execuções/períodos diferentes.
  await fs.promises.rm(ROOT, { recursive: true, force: true });
  await Promise.all(
    Object.values(DIRS).map((d) => fs.promises.mkdir(path.join(ROOT, d), { recursive: true }))
  );

  console.log(`Extraindo ${zipFiles.length} ZIPs de ${ZIPS_DIR}`);
  const limit = pLimit(4);
  await Promise.all(
    zipFiles.map((zipPath) =>
      limit(async () => {
        const fileName = path.basename(zipPath);
        const destSub = routeFor(fileName);
        const destDir = destSub ? path.join(ROOT, destSub) : ROOT;
        await extractZip(zipPath, destDir);
      })
    )
  );
  console.log('ZIPs extraídos.');
}

async function extractZip(zipPath, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;
    const baseName = path.basename(entry.path).replace(/[/\\]+/g, '');
    const outName = /\.csv$/i.test(baseName) ? baseName : `${baseName}.csv`;
    await pipeline(entry.stream(), fs.createWriteStream(path.join(destDir, outName)));
  }
}

/* =============== CSV READER =============== */
function listAllFiles(dirAbs) {
  if (!fs.existsSync(dirAbs)) return [];
  return fs.readdirSync(dirAbs).filter((f) => fs.statSync(path.join(dirAbs, f)).isFile());
}

function streamCsvRows(fullPath, headers, onRow, { delimiter = ';', bulkFlush = async () => { } } = {}) {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(fullPath, { encoding: 'latin1', highWaterMark: 64 * 1024 });
    const parser = parse({ delimiter, columns: headers, relax_column_count: true, bom: true, trim: true });
    readStream.on('error', reject);
    parser.on('error', reject);
    parser.on('data', (row) => {
      if (onRow(row, parser) === false) parser.pause();
    });
    parser.on('end', async () => {
      try {
        await bulkFlush();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    readStream.pipe(parser);
  });
}

// Lê um CSV inteiro empurrando ops e fazendo flush por lote.
async function importCsv(col, fullPath, headers, rowToOp, { onProgress } = {}) {
  const ops = [];
  let count = 0;
  const flush = () => bulkWriteWithRetry(col, ops);

  await streamCsvRows(
    fullPath,
    headers,
    (row, parser) => {
      const op = rowToOp(row);
      if (!op) {
        stats.descartadas++;
        return;
      }
      ops.push(op);
      count++;
      if (onProgress && count % 100000 === 0) onProgress(count);
      if (ops.length >= BULK) {
        parser.pause();
        flush().then(() => parser.resume()).catch((err) => parser.emit('error', err));
      }
    },
    { bulkFlush: flush }
  );
  return count;
}

function socioIdHash(row) {
  const key = [
    row['CNPJ BÁSICO'],
    row['IDENTIFICADOR DE SÓCIO'],
    row['CNPJ/CPF DO SÓCIO'],
    row['NOME DO SÓCIO (NO CASO PF) OU RAZÃO SOCIAL (NO CASO PJ)'],
    row['DATA DE ENTRADA SOCIEDADE'],
  ].map((x) => (x ?? '').toString()).join('|');
  return crypto.createHash('sha1').update(key).digest('hex');
}

/* =============== ÍNDICES =============== */
// Índices das coleções brutas usados pela carga e pela agregação.
// empresas_agg NÃO é tocada aqui: seus índices são gerenciados à parte.
export async function ensureIndexes(client) {
  const db = client.db(DB_NAME);
  const make = async (coll, spec, opts = {}) => {
    try {
      await db.collection(coll).createIndex(spec, opts);
    } catch (err) {
      // 85/86: índice equivalente já existe com outro nome/opções. Seguir.
      if (err.code === 85 || err.code === 86) return;
      throw err;
    }
  };
  await make('empresas', { cnpjBasico: 1 }, { unique: true });
  await make('empresas', { etlPeriodo: 1, cnpjBasico: 1 });
  await make('estabelecimentos', { cnpjBasico: 1 });
  await make('socios', { cnpjBasico: 1 });
  await make('simples', { cnpjBasico: 1 }, { unique: true });
  await make('etl_runs', { startedAt: -1 });
  for (const c of ['naturezas', 'municipios', 'paises', 'qualificacoes', 'cnaes', 'motivos']) {
    await make(c, { codigo: 1 }, { unique: true });
  }

  // Índice legado que causava E11000 em estabelecimentos.
  try {
    await db.collection('estabelecimentos').dropIndex('cnpj_1');
    console.log('Índice legado cnpj_1 removido');
  } catch (err) {
    if (err.codeName !== 'IndexNotFound' && err.code !== 27 && err.code !== 26) throw err;
  }
}

/* =============== IMPORTADORES =============== */
// Domínios são pequenos: sempre upsert por código, sem apagar (a API nunca vê coleção vazia).
async function importDom2(client, collName, subdir) {
  const col = client.db(DB_NAME).collection(collName);
  const folder = path.join(ROOT, subdir);
  for (const f of listAllFiles(folder)) {
    const n = await importCsv(col, path.join(folder, f), HEADERS.DOM2, (row) => {
      const codigo = clean(row['CÓDIGO']);
      if (!codigo) return null;
      return {
        updateOne: {
          filter: { _id: codigo },
          update: { $set: { codigo, descricao: clean(row['DESCRIÇÃO']), etlPeriodo: PERIODO } },
          upsert: true,
        },
      };
    });
    console.log(`Domínio ${collName}: ${f} → ${n}`);
  }
}

async function importEmpresas(client) {
  const col = client.db(DB_NAME).collection('empresas');
  const dir = path.join(ROOT, DIRS.empresas);
  for (const f of listAllFiles(dir)) {
    const n = await importCsv(col, path.join(dir, f), HEADERS.EMPRESAS, (row) => {
      const base = ensure8(row['CNPJ BÁSICO']);
      if (!clean(row['CNPJ BÁSICO'])) return null;
      const capital = row['CAPITAL SOCIAL DA EMPRESA']
        ? Number(String(row['CAPITAL SOCIAL DA EMPRESA']).replace(/\./g, '').replace(',', '.'))
        : undefined;
      const doc = {
        cnpjBasico: base,
        razaoSocial: clean(row['RAZÃO SOCIAL / NOME EMPRESARIAL']),
        naturezaCodigo: clean(row['NATUREZA JURÍDICA']) || undefined,
        qualificacaoResponsavelCodigo: clean(row['QUALIFICAÇÃO DO RESPONSÁVEL']) || undefined,
        capitalSocial: Number.isFinite(capital) ? capital : undefined,
        porte: row['PORTE DA EMPRESA']
          ? { codigo: row['PORTE DA EMPRESA'], descricao: PORTE_MAP[row['PORTE DA EMPRESA']] ?? 'Desconhecido' }
          : undefined,
        enteFederativoResponsavel: clean(row['ENTE FEDERATIVO RESPONSÁVEL']) || undefined,
        etlPeriodo: PERIODO,
        updatedAt: new Date(),
      };
      return {
        updateOne: {
          filter: { cnpjBasico: base },
          update: buildUpdate(doc, { setOnInsert: { _id: base, createdAt: new Date() } }),
          upsert: true,
        },
      };
    }, { onProgress: (c) => console.log(`  Empresas ${f}: ${c.toLocaleString()}`) });
    console.log(`Empresas: ${f} → ${n.toLocaleString()}`);
  }
}

async function importEstabelecimentos(client) {
  const col = client.db(DB_NAME).collection('estabelecimentos');
  const dir = path.join(ROOT, DIRS.estab);
  for (const f of listAllFiles(dir)) {
    const n = await importCsv(col, path.join(dir, f), HEADERS.ESTABELECIMENTOS, (row) => {
      if (!clean(row['CNPJ BÁSICO'])) return null;
      const base = ensure8(row['CNPJ BÁSICO']);
      const cnpj = joinCnpj(row['CNPJ BÁSICO'], row['CNPJ ORDEM'], row['CNPJ DV']);
      const sec = clean(row['CNAE FISCAL SECUNDÁRIA']);
      const doc = {
        cnpj,
        cnpjBasico: base,
        nomeFantasia: clean(row['NOME FANTASIA']) || undefined,
        situacaoCadastral: clean(row['SITUAÇÃO CADASTRAL']) || undefined,
        dataSituacaoCadastral: clean(row['DATA SITUAÇÃO CADASTRAL']) || undefined,
        motivoSituacaoCadastralCodigo: clean(row['MOTIVO SITUAÇÃO CADASTRAL']) || undefined,
        paisCodigo: clean(row['PAIS']) || undefined,
        dataInicioAtividade: clean(row['DATA DE INÍCIO ATIVIDADE']) || undefined,
        cnaeFiscalPrincipalCodigo: clean(row['CNAE FISCAL PRINCIPAL']) || undefined,
        cnaesSecundariosCodigos: sec ? sec.split(',').map((s) => s.trim()).filter(Boolean) : [],
        endereco: compactObj({
          tipoLogradouro: clean(row['TIPO DE LOGRADOURO']) || undefined,
          logradouro: clean(row['LOGRADOURO']) || undefined,
          numero: clean(row['NÚMERO']) || undefined,
          complemento: clean(row['COMPLEMENTO']) || undefined,
          bairro: clean(row['BAIRRO']) || undefined,
          cep: clean(row['CEP']) || undefined,
          uf: clean(row['UF']) || undefined,
          municipioCodigo: clean(row['MUNICÍPIO']) || undefined,
        }),
        telefones: [
          clean(row['DDD 1']) && clean(row['TELEFONE 1']) ? `${clean(row['DDD 1'])}${clean(row['TELEFONE 1'])}` : null,
          clean(row['DDD 2']) && clean(row['TELEFONE 2']) ? `${clean(row['DDD 2'])}${clean(row['TELEFONE 2'])}` : null,
        ].filter(Boolean),
        email: clean(row['CORREIO ELETRÔNICO']) || undefined,
        situacaoEspecial: clean(row['SITUAÇÃO ESPECIAL']) || undefined,
        dataSituacaoEspecial: clean(row['DATA DA SITUAÇÃO ESPECIAL']) || undefined,
        etlPeriodo: PERIODO,
        updatedAt: new Date(),
      };
      return {
        updateOne: {
          // Em produção o _id dos estabelecimentos é ObjectId (não o CNPJ). Casar por
          // cnpjBasico (indexado) + cnpj evita duplicar os 139M documentos existentes.
          filter: { cnpjBasico: base, cnpj },
          update: buildUpdate(doc, { setOnInsert: { createdAt: new Date() } }),
          upsert: true,
        },
      };
    }, { onProgress: (c) => console.log(`  Estabelecimentos ${f}: ${c.toLocaleString()}`) });
    console.log(`Estabelecimentos: ${f} → ${n.toLocaleString()}`);
  }
}

async function importSocios(client) {
  const db = client.db(DB_NAME);
  const col = db.collection('socios');
  const statusCol = db.collection('import_status'); // arquivos concluídos, por período
  const dir = path.join(ROOT, DIRS.socios);

  for (const f of listAllFiles(dir)) {
    const key = { collection: 'socios', periodo: PERIODO, file: f };
    if (await statusCol.findOne({ ...key, done: true })) {
      console.log(`Sócios: ${f} já importado neste período, pulando`);
      continue;
    }
    const n = await importCsv(col, path.join(dir, f), HEADERS.SOCIOS, (row) => {
      if (!clean(row['CNPJ BÁSICO'])) return null;
      const base = ensure8(row['CNPJ BÁSICO']);
      // Sócios legados em produção têm _id ObjectId e não guardam CPF/data de entrada,
      // então não dá para casar com eles. Os novos entram com _id = hash e etlPeriodo;
      // os legados (sem etlPeriodo) saem na purga final.
      const _id = socioIdHash(row);
      const doc = {
        cnpjBasico: base,
        identificadorSocio: clean(row['IDENTIFICADOR DE SÓCIO']) || undefined,
        nomeSocioRazaoSocial: clean(row['NOME DO SÓCIO (NO CASO PF) OU RAZÃO SOCIAL (NO CASO PJ)']) || undefined,
        qualificacaoSocioCodigo: clean(row['QUALIFICAÇÃO DO SÓCIO']) || undefined,
        representante: compactObj({
          documento: clean(row['REPRESENTANTE LEGAL']) || undefined,
          nome: clean(row['NOME DO REPRESENTANTE']) || undefined,
          qualificacaoCodigo: clean(row['QUALIFICAÇÃO DO REPRESENTANTE LEGAL']) || undefined,
        }),
        paisCodigo: clean(row['PAIS']) || undefined,
        etlPeriodo: PERIODO,
        updatedAt: new Date(),
      };
      return {
        updateOne: {
          filter: { _id },
          update: buildUpdate(doc, { setOnInsert: { createdAt: new Date() } }),
          upsert: true,
        },
      };
    }, { onProgress: (c) => console.log(`  Sócios ${f}: ${c.toLocaleString()}`) });
    console.log(`Sócios: ${f} → ${n.toLocaleString()}`);

    await statusCol.updateOne(key, { $set: { ...key, done: true, finishedAt: new Date() } }, { upsert: true });
  }
}

async function importSimples(client) {
  const col = client.db(DB_NAME).collection('simples');
  const dir = path.join(ROOT, DIRS.simples);
  for (const f of listAllFiles(dir)) {
    const n = await importCsv(col, path.join(dir, f), HEADERS.SIMPLES, (row) => {
      if (!clean(row['CNPJ BÁSICO'])) return null;
      const base = ensure8(row['CNPJ BÁSICO']);
      const doc = {
        cnpjBasico: base,
        opcaoSimples: SN(clean(row['OPÇÃO PELO SIMPLES'])),
        dataOpcaoSimples: clean(row['DATA DE OPÇÃO PELO SIMPLES']) || undefined,
        dataExclusaoSimples: clean(row['DATA DE EXCLUSÃO DO SIMPLES']) || undefined,
        opcaoMei: SN(clean(row['OPÇÃO PELO MEI'])),
        dataOpcaoMei: clean(row['DATA DE OPÇÃO PELO MEI']) || undefined,
        dataExclusaoMei: clean(row['DATA DE EXCLUSÃO DO MEI']) || undefined,
        etlPeriodo: PERIODO,
        updatedAt: new Date(),
      };
      return {
        updateOne: {
          filter: { cnpjBasico: base },
          update: buildUpdate(doc, { setOnInsert: { createdAt: new Date() } }),
          upsert: true,
        },
      };
    });
    console.log(`Simples: ${f} → ${n.toLocaleString()}`);
  }
}

/* =============== AGREGAÇÃO: empresas → empresas_agg =============== */
async function loadDomainMap(db, collName) {
  const map = new Map();
  const docs = await withRetry(
    () => db.collection(collName).find({}, { projection: { codigo: 1, descricao: 1, _id: 0 } }).toArray(),
    { label: `domínio ${collName}` }
  );
  for (const d of docs) if (d.codigo) map.set(d.codigo, d.descricao || '');
  return map;
}

const groupBy = (arr, key) => {
  const m = new Map();
  for (const item of arr) {
    const k = item[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
};

// Garante documento abaixo de 16MB: corta sócios e depois estabelecimentos.
function fitDocument(doc) {
  let size = BSON.calculateObjectSize(doc);
  if (size <= MAX_DOC_BYTES) return doc;
  console.warn(`Documento ${doc.cnpjBasico} com ${(size / 1048576).toFixed(1)}MB; truncando`);
  const original = { socios: doc.socios.length, estabelecimentos: doc.estabelecimentos.length };
  while (size > MAX_DOC_BYTES && doc.socios.length > 100) {
    doc.socios = doc.socios.slice(0, Math.floor(doc.socios.length / 2));
    size = BSON.calculateObjectSize(doc);
  }
  while (size > MAX_DOC_BYTES && doc.estabelecimentos.length > 100) {
    doc.estabelecimentos = doc.estabelecimentos.slice(0, Math.floor(doc.estabelecimentos.length / 2));
    size = BSON.calculateObjectSize(doc);
  }
  doc.truncado = { ...original, em: new Date() };
  return doc;
}

/**
 * Reconstrói/atualiza empresas_agg a partir das coleções brutas do período.
 * Percorre TODAS as empresas do período (por cnpjBasico) e faz replaceOne upsert,
 * então registros existentes são atualizados. Não faz drop; índices permanecem.
 * Qualquer falha não transitória propaga (nada é engolido).
 */
export async function aggregateEmpresas(client, { periodo, resumeFrom = '', onCheckpoint } = {}) {
  const db = client.db(DB_NAME);
  const colAgg = db.collection('empresas_agg');
  const colEmp = db.collection('empresas');
  const colEst = db.collection('estabelecimentos');
  const colSoc = db.collection('socios');
  const colSim = db.collection('simples');

  console.log('Carregando domínios...');
  const [mapNat, mapMun, mapQual, mapCnae] = await Promise.all(
    ['naturezas', 'municipios', 'qualificacoes', 'cnaes'].map((c) => loadDomainMap(db, c))
  );
  const desc = (map, code) => ({ codigo: code, descricao: map.get(code) || 'Não encontrado' });

  let last = resumeFrom;
  let processed = 0;
  let truncados = 0;
  const projection = {
    cnpjBasico: 1, razaoSocial: 1, naturezaCodigo: 1, qualificacaoResponsavelCodigo: 1,
    capitalSocial: 1, porte: 1, enteFederativoResponsavel: 1,
  };

  for (;;) {
    const filter = { etlPeriodo: periodo, ...(last ? { cnpjBasico: { $gt: last } } : {}) };
    const batch = await withRetry(
      () => colEmp.find(filter, { projection }).sort({ cnpjBasico: 1 }).limit(AGG_BATCH).toArray(),
      { label: 'leitura empresas' }
    );
    if (batch.length === 0) break;

    const bases = batch.map((e) => e.cnpjBasico);
    const [estabs, socios, simples] = await withRetry(
      () => Promise.all([
        colEst.find({ cnpjBasico: { $in: bases }, etlPeriodo: periodo }).toArray(),
        colSoc.find({ cnpjBasico: { $in: bases }, etlPeriodo: periodo }).toArray(),
        colSim.find({ cnpjBasico: { $in: bases }, etlPeriodo: periodo }).toArray(),
      ]),
      { label: 'leitura estab/sócios/simples' }
    );
    const estByBase = groupBy(estabs, 'cnpjBasico');
    const socByBase = groupBy(socios, 'cnpjBasico');
    const simByBase = new Map(simples.map((s) => [s.cnpjBasico, s]));

    const ops = batch.map((emp) => {
      const base = emp.cnpjBasico;
      const sim = simByBase.get(base);
      if (sim) delete sim.etlPeriodo;

      let doc = {
        cnpjBasico: base,
        razaoSocial: emp.razaoSocial || 'NÃO INFORMADO',
        natureza: emp.naturezaCodigo ? desc(mapNat, emp.naturezaCodigo) : null,
        qualificacaoResponsavel: emp.qualificacaoResponsavelCodigo
          ? desc(mapQual, emp.qualificacaoResponsavelCodigo)
          : null,
        ...(emp.capitalSocial !== undefined ? { capitalSocial: emp.capitalSocial } : {}),
        ...(emp.porte ? { porte: emp.porte } : {}),
        ...(emp.enteFederativoResponsavel ? { enteFederativoResponsavel: emp.enteFederativoResponsavel } : {}),
        estabelecimentos: (estByBase.get(base) || []).map((e) => {
          const { etlPeriodo, ...rest } = e;
          return {
            ...rest,
            endereco: {
              ...rest.endereco,
              municipio: rest.endereco?.municipioCodigo ? desc(mapMun, rest.endereco.municipioCodigo) : null,
            },
            cnaeFiscalPrincipal: rest.cnaeFiscalPrincipalCodigo
              ? desc(mapCnae, rest.cnaeFiscalPrincipalCodigo)
              : null,
          };
        }),
        socios: (socByBase.get(base) || []).map((s) => {
          const { etlPeriodo, ...rest } = s;
          return {
            ...rest,
            qualificacaoSocio: rest.qualificacaoSocioCodigo ? desc(mapQual, rest.qualificacaoSocioCodigo) : null,
          };
        }),
        simples: sim || null,
        etlPeriodo: periodo,
        updatedAt: new Date(),
      };
      const fitted = fitDocument(doc);
      if (fitted.truncado) truncados++;
      doc = fitted;

      return { replaceOne: { filter: { cnpjBasico: base }, replacement: doc, upsert: true } };
    });

    await bulkWriteWithRetry(colAgg, ops);

    last = bases[bases.length - 1];
    processed += batch.length;
    if (onCheckpoint) await onCheckpoint(last, processed);
    if (processed % 50000 < AGG_BATCH) console.log(`empresas_agg: ${processed.toLocaleString()} empresas`);
  }

  console.log(`Agregação concluída: ${processed.toLocaleString()} empresas (${truncados} truncadas)`);
  return { processed, truncados };
}

/* =============== PURGA DE REGISTROS DE PERÍODOS ANTERIORES =============== */
// Só deve ser chamada depois de agregação completa e validada.
export async function purgeStale(client, periodo) {
  const db = client.db(DB_NAME);
  const result = {};
  for (const name of ['empresas_agg', 'empresas', 'estabelecimentos', 'socios', 'simples']) {
    const r = await withRetry(
      () => db.collection(name).deleteMany({ etlPeriodo: { $ne: periodo } }),
      { label: `purge ${name}`, max: 5 }
    );
    result[name] = r.deletedCount;
    console.log(`Purga ${name}: ${r.deletedCount.toLocaleString()} removidos`);
  }
  return result;
}

/* =============== REMOÇÃO DE ARQUIVOS DE PERÍODOS ANTIGOS =============== */
export async function cleanupFiles(keepPeriodos = []) {
  for (const base of [DATA_ROOT, ZIPS_ROOT]) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      if (keepPeriodos.includes(name)) continue;
      await fs.promises.rm(path.join(base, name), { recursive: true, force: true });
    }
  }
}

/* =============== ENTRADAS =============== */
function setPeriodo(periodo) {
  if (!/^\d{4}-\d{2}$/.test(periodo || '')) throw new Error(`Período inválido: ${periodo}`);
  PERIODO = periodo;
  ROOT = path.join(DATA_ROOT, periodo);
  ZIPS_DIR = path.join(ZIPS_ROOT, periodo);
  stats.descartadas = 0;
}

/** Extrai + importa tabelas brutas do período. Retorna contagens. */
export async function runImport(client, { periodo, skipExtract = false } = {}) {
  setPeriodo(periodo);

  if (!skipExtract) {
    console.log('> Extraindo ZIPs...');
    await extractAllLocalZips();
  }

  console.log('> Índices...');
  await ensureIndexes(client);

  console.log('> Domínios...');
  await importDom2(client, 'naturezas', DIRS.naturezas);
  await importDom2(client, 'municipios', DIRS.municipios);
  await importDom2(client, 'paises', DIRS.paises);
  await importDom2(client, 'qualificacoes', DIRS.qualificacoes);
  await importDom2(client, 'cnaes', DIRS.cnaes);
  await importDom2(client, 'motivos', DIRS.motivos);

  console.log('> Tabelas principais...');
  await importEmpresas(client);
  await importEstabelecimentos(client);
  await importSocios(client);
  await importSimples(client);

  if (stats.descartadas > 0) {
    console.warn(`Atenção: ${stats.descartadas.toLocaleString()} linhas descartadas (CNPJ básico vazio)`);
  }
  return { linhasDescartadas: stats.descartadas };
}

export function newMongoClient() {
  return new MongoClient(buildMongoUri(), {
    maxPoolSize: 10,
    minPoolSize: 2,
    maxIdleTimeMS: 0,
    socketTimeoutMS: 0,
    connectTimeoutMS: 60000,
    serverSelectionTimeoutMS: 30000,
    heartbeatFrequencyMS: 10000,
    retryWrites: true,
    retryReads: true,
  });
}

/* =============== CLI: node etl/import.js [YYYY-MM] =============== */
// Uso manual: importa e agrega um período já baixado, sem lock/etl_runs.
// Para o fluxo completo e automático use etl/pipeline.js (npm run etl:once).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const periodo = process.argv[2] || process.env.RF_PERIODO;
    if (!periodo) throw new Error('Informe o período: node etl/import.js YYYY-MM');
    const client = newMongoClient();
    await client.connect();
    try {
      await runImport(client, { periodo, skipExtract: process.env.SKIP_EXTRACT === '1' });
      if (process.env.SKIP_AGG !== '1') await aggregateEmpresas(client, { periodo });
      console.log('Concluído (sem purga de períodos antigos; use o pipeline para isso).');
    } finally {
      await client.close();
    }
  })().catch((err) => {
    console.error('Erro fatal:', err);
    process.exit(1);
  });
}
