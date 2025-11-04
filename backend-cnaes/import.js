/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import unzipper from 'unzipper';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

/* ================= CONFIG ================= */
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'cnpj';
const ROOT = path.resolve(process.env.DATA_ROOT || './dados_cnpj');

const BASE_URL =
  process.env.RFB_BASE_URL ||
  'https://arquivos.receitafederal.gov.br/dados/cnpj/dados_abertos_cnpj';

const CONCURRENCY_DOWNLOAD = Number(process.env.CONCURRENCY_DOWNLOAD || 4);
const SOCKET_TIMEOUT_MS = Number(process.env.SOCKET_TIMEOUT_MS || 600000);

/* Dirs padronizados para destino dos CSVs */
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
    'CNPJ BÁSICO',
    'CNPJ ORDEM',
    'CNPJ DV',
    'IDENTIFICADOR MATRIZ/FILIAL',
    'NOME FANTASIA',
    'SITUAÇÃO CADASTRAL',
    'DATA SITUAÇÃO CADASTRAL',
    'MOTIVO SITUAÇÃO CADASTRAL',
    'NOME DA CIDADE NO EXTERIOR',
    'PAIS',
    'DATA DE INÍCIO ATIVIDADE',
    'CNAE FISCAL PRINCIPAL',
    'CNAE FISCAL SECUNDÁRIA',
    'TIPO DE LOGRADOURO',
    'LOGRADOURO',
    'NÚMERO',
    'COMPLEMENTO',
    'BAIRRO',
    'CEP',
    'UF',
    'MUNICÍPIO',
    'DDD 1',
    'TELEFONE 1',
    'DDD 2',
    'TELEFONE 2',
    'DDD DO FAX',
    'FAX',
    'CORREIO ELETRÔNICO',
    'SITUAÇÃO ESPECIAL',
    'DATA DA SITUAÇÃO ESPECIAL',
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
    'CNPJ BÁSICO',
    'OPÇÃO PELO SIMPLES',
    'DATA DE OPÇÃO PELO SIMPLES',
    'DATA DE EXCLUSÃO DO SIMPLES',
    'OPÇÃO PELO MEI',
    'DATA DE OPÇÃO PELO MEI',
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
const PORTE_MAP = { '1': 'Não informado', '2': 'Micro Empresa', '3': 'Empresa de Pequeno Porte', '5': 'Demais' };

/* p-limit simples */
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
      .then((v) => {
        resolve(v);
        next();
      })
      .catch((e) => {
        reject(e);
        next();
      });
  };
  return (fn) =>
    new Promise((res, rej) => {
      const task = () => run(fn, res, rej);
      active < concurrency ? task() : queue.push(task);
    });
};

/* --------------- Downloader --------------- */

/** baixa um URL para um arquivo local */
async function downloadToFile(url, outFile) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar ${url}`);
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  const fileStream = fs.createWriteStream(outFile);
  await pipeline(res.body, fileStream);
}

/** extrai ZIP para uma pasta, renomeando qualquer entrada sem extensão para .csv */
async function extractZip(zipPath, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);

  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;

    // nome normalizado sempre terminando com .csv
    const baseName = path.basename(entry.path).replace(/[/\\]+/g, '');
    const hasCsv = /\.csv$/i.test(baseName);
    const outName = hasCsv ? baseName : `${baseName}.csv`;
    const outPath = path.join(destDir, outName);

    const readStream = entry.stream();
    const writeStream = fs.createWriteStream(outPath);
    await pipeline(readStream, writeStream);
  }
}

/** baixa todos os zips do mês mais recente e extrai para ROOT/<pasta> */
async function fetchLatestMonthAndExtract() {
  // 1) pega índice raiz
  const idxRes = await fetch(`${BASE_URL}/?C=N;O=D`);
  if (!idxRes.ok) throw new Error(`Falha ao abrir índice raiz (${idxRes.status})`);
  const idxHtml = await idxRes.text();

  // 2) captura diretórios no formato YYYY-MM/
  const dirMatches = [...idxHtml.matchAll(/href="(\d{4}-\d{2})\/"/g)].map((m) => m[1]);
  if (!dirMatches.length) throw new Error('Nenhum diretório YYYY-MM encontrado na RFB');
  // como já vem ordenado por nome desc, o primeiro tende a ser o mais novo; mas vamos ordenar por data
  const latest = dirMatches.sort().at(-1);
  console.log(`> Último mês encontrado: ${latest}`);

  // 3) abre o índice do mês
  const monRes = await fetch(`${BASE_URL}/${latest}/?C=N;O=D`);
  if (!monRes.ok) throw new Error(`Falha ao abrir mês ${latest} (${monRes.status})`);
  const monHtml = await monRes.text();

  // 4) links .zip
  const zipLinks = [...monHtml.matchAll(/href="([^"]+\.zip)"/gi)].map((m) => m[1]);
  if (!zipLinks.length) throw new Error('Nenhum .zip encontrado no mês mais recente');

  // 5) Decide a pasta de destino de cada ZIP pelo prefixo do nome
  const routeFor = (file) => {
    const f = file.toLowerCase();
    if (f.startsWith('empresa')) return DIRS.empresas;
    if (f.startsWith('estabelec')) return DIRS.estab;
    if (f.startsWith('socio')) return DIRS.socios;
    if (f.startsWith('simples')) return DIRS.simples;
    if (f.startsWith('natureza')) return DIRS.naturezas;
    if (f.startsWith('municipio')) return DIRS.municipios;
    if (f.startsWith('pais')) return DIRS.paises;
    if (f.startsWith('qualificacao')) return DIRS.qualificacoes;
    if (f.startsWith('cnae')) return DIRS.cnaes;
    if (f.startsWith('motivo')) return DIRS.motivos;
    // fallback: coloca em raiz
    return '';
  };

  // 6) baixa e extrai com concorrência limitada
  const tmp = path.join(ROOT, '_tmp', latest);
  await fs.promises.mkdir(tmp, { recursive: true });

  const limit = pLimit(CONCURRENCY_DOWNLOAD);
  await Promise.all(
    zipLinks.map((href) =>
      limit(async () => {
        const url = `${BASE_URL}/${latest}/${href}`;
        const localZip = path.join(tmp, href);
        console.log(`Baixando: ${href}`);
        await downloadToFile(url, localZip);

        const destSub = routeFor(href);
        const dest = destSub ? path.join(ROOT, destSub) : ROOT;
        console.log(`Extraindo: ${href} -> ${dest}`);
        await extractZip(localZip, dest);
      })
    )
  );

  console.log('✔ Download e extração concluídos.');
}

/* --------------- CSV Reader Helpers --------------- */
/* Importante: alguns dumps vêm em ISO-8859-1. Se perceber caracteres estranhos,
   troque "encoding" para 'latin1' no createReadStream. Mantive 'utf8' por padrão. */
function listAllFiles(dirAbs) {
  if (!fs.existsSync(dirAbs)) return [];
  return fs.readdirSync(dirAbs).filter((f) => fs.statSync(path.join(dirAbs, f)).isFile());
}
function streamCsvRows(fullPath, headers, onRow, { delimiter = ';', bulkFlush = async () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(fullPath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
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
function socioIdHash(row) {
  const key = [
    row['CNPJ BÁSICO'],
    row['IDENTIFICADOR DE SÓCIO'],
    row['CNPJ/CPF DO SÓCIO'],
    row['NOME DO SÓCIO (NO CASO PF) OU RAZÃO SOCIAL (NO CASO PJ)'],
    row['DATA DE ENTRADA SOCIEDADE'],
  ]
    .map((x) => (x ?? '').toString())
    .join('|');
  return crypto.createHash('sha1').update(key).digest('hex');
}

/* ============= IMPORTADORES (UPSERT) ============= */
async function importDom2(client, collName, subdir) {
  const db = client.db(DB_NAME);
  const col = db.collection(collName);
  await col.createIndex({ codigo: 1 });

  const folder = path.join(ROOT, subdir);
  for (const f of listAllFiles(folder)) {
    const full = path.join(folder, f);
    const ops = [];
    const BULK = 1000;
    const flush = async () => {
      if (ops.length) await col.bulkWrite(ops.splice(0), { ordered: false });
    };

    await streamCsvRows(
      full,
      HEADERS.DOM2,
      (row, parser) => {
        const codigo = clean(row['CÓDIGO']);
        if (!codigo) return;
        ops.push({
          updateOne: {
            filter: { _id: codigo },
            update: { $set: { _id: codigo, codigo, descricao: clean(row['DESCRIÇÃO']) } },
            upsert: true,
          },
        });
        if (ops.length >= BULK) {
          parser.pause();
          flush().then(() => parser.resume());
        }
      },
      { bulkFlush: flush }
    );
    console.log(`Domínio ${collName}: ${f} ok`);
  }
}

async function importEmpresas(client) {
  const db = client.db(DB_NAME);
  const col = db.collection('empresas');
  await col.createIndex({ cnpjBasico: 1 }, { unique: true });

  for (const f of listAllFiles(path.join(ROOT, DIRS.empresas))) {
    const full = path.join(ROOT, DIRS.empresas, f);
    let count = 0;
    const ops = [];
    const BULK = 1000;

    const flush = async () => {
      if (ops.length) await col.bulkWrite(ops.splice(0), { ordered: false });
    };

    await streamCsvRows(
      full,
      HEADERS.EMPRESAS,
      (row, parser) => {
        const base = ensure8(row['CNPJ BÁSICO']);
        if (!base) return;
        const doc = {
          cnpjBasico: base,
          razaoSocial: clean(row['RAZÃO SOCIAL / NOME EMPRESARIAL']),
          naturezaCodigo: clean(row['NATUREZA JURÍDICA']) || undefined,
          qualificacaoResponsavelCodigo: clean(row['QUALIFICAÇÃO DO RESPONSÁVEL']) || undefined,
          capitalSocial: row['CAPITAL SOCIAL DA EMPRESA']
            ? Number(String(row['CAPITAL SOCIAL DA EMPRESA']).replace(/\./g, '').replace(',', '.'))
            : undefined,
          porte: row['PORTE DA EMPRESA']
            ? { codigo: row['PORTE DA EMPRESA'], descricao: PORTE_MAP[row['PORTE DA EMPRESA']] ?? 'Desconhecido' }
            : undefined,
          enteFederativoResponsavel: clean(row['ENTE FEDERATIVO RESPONSÁVEL']) || undefined,
          updatedAt: new Date(),
        };
        ops.push({
          updateOne: {
            filter: { cnpjBasico: base },
            update: { $set: doc, $setOnInsert: { _id: base, createdAt: new Date() } },
            upsert: true,
          },
        });
        if (++count % 20000 === 0) process.stdout.write(`Empresas: ${count}\r`);
        if (ops.length >= BULK) {
          parser.pause();
          flush().then(() => parser.resume());
        }
      },
      { bulkFlush: flush }
    );
    console.log(`\nEmpresas: arquivo ${f} concluído`);
  }
}

async function importEstabelecimentos(client) {
  const db = client.db(DB_NAME);
  const col = db.collection('estabelecimentos');
  await col.createIndex({ cnpjBasico: 1 });
  await col.createIndex({ _id: 1 }, { unique: true });

  for (const f of listAllFiles(path.join(ROOT, DIRS.estab))) {
    const full = path.join(ROOT, DIRS.estab, f);
    let count = 0;
    const ops = [];
    const BULK = 1000;

    const flush = async () => {
      if (ops.length) await col.bulkWrite(ops.splice(0), { ordered: false });
    };

    await streamCsvRows(
      full,
      HEADERS.ESTABELECIMENTOS,
      (row, parser) => {
        const base = ensure8(row['CNPJ BÁSICO']);
        if (!base) return;
        const cnpj = joinCnpj(row['CNPJ BÁSICO'], row['CNPJ ORDEM'], row['CNPJ DV']);

        const doc = {
          _id: cnpj,
          cnpj,
          cnpjBasico: base,
          nomeFantasia: clean(row['NOME FANTASIA']) || undefined,
          motivoSituacaoCadastralCodigo: clean(row['MOTIVO SITUAÇÃO CADASTRAL']) || undefined,
          paisCodigo: clean(row['PAIS']) || undefined,
          endereco: {
            municipioCodigo: clean(row['MUNICÍPIO']) || undefined,
            uf: clean(row['UF']) || undefined,
            cep: clean(row['CEP']) || undefined,
            bairro: clean(row['BAIRRO']) || undefined,
            logradouro: clean(row['LOGRADOURO']) || undefined,
            numero: clean(row['NÚMERO']) || undefined,
            complemento: clean(row['COMPLEMENTO']) || undefined,
          },
          cnaeFiscalPrincipalCodigo: clean(row['CNAE FISCAL PRINCIPAL']) || undefined,
          cnaesSecundariosCodigos: clean(row['CNAE FISCAL SECUNDÁRIA'])
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          updatedAt: new Date(),
        };

        ops.push({
          updateOne: {
            filter: { _id: cnpj },
            update: { $set: doc, $setOnInsert: { createdAt: new Date() } },
            upsert: true,
          },
        });

        if (++count % 20000 === 0) process.stdout.write(`Estabs: ${count}\r`);
        if (ops.length >= BULK) {
          parser.pause();
          flush().then(() => parser.resume());
        }
      },
      { bulkFlush: flush }
    );
    console.log(`\nEstabelecimentos: arquivo ${f} concluído`);
  }
}

async function importSocios(client) {
  const db = client.db(DB_NAME);
  const col = db.collection('socios');
  await col.createIndex({ cnpjBasico: 1 });
  await col.createIndex({ _id: 1 }, { unique: true });

  for (const f of listAllFiles(path.join(ROOT, DIRS.socios))) {
    const full = path.join(ROOT, DIRS.socios, f);
    let count = 0;
    const ops = [];
    const BULK = 1000;

    const flush = async () => {
      if (ops.length) await col.bulkWrite(ops.splice(0), { ordered: false });
    };

    await streamCsvRows(
      full,
      HEADERS.SOCIOS,
      (row, parser) => {
        const base = ensure8(row['CNPJ BÁSICO']);
        if (!base) return;
        const _id = socioIdHash(row);
        const doc = {
          _id,
          cnpjBasico: base,
          identificadorSocio: clean(row['IDENTIFICADOR DE SÓCIO']) || undefined,
          nomeSocioRazaoSocial: clean(row['NOME DO SÓCIO (NO CASO PF) OU RAZÃO SOCIAL (NO CASO PJ)']) || undefined,
          qualificacaoSocioCodigo: clean(row['QUALIFICAÇÃO DO SÓCIO']) || undefined,
          representante: {
            documento: clean(row['REPRESENTANTE LEGAL']) || undefined,
            nome: clean(row['NOME DO REPRESENTANTE']) || undefined,
            qualificacaoCodigo: clean(row['QUALIFICAÇÃO DO REPRESENTANTE LEGAL']) || undefined,
          },
          paisCodigo: clean(row['PAIS']) || undefined,
          updatedAt: new Date(),
        };
        ops.push({
          updateOne: {
            filter: { _id },
            update: { $set: doc, $setOnInsert: { createdAt: new Date() } },
            upsert: true,
          },
        });

        if (++count % 50000 === 0) process.stdout.write(`Socios: ${count}\r`);
        if (ops.length >= BULK) {
          parser.pause();
          flush().then(() => parser.resume());
        }
      },
      { bulkFlush: flush }
    );
    console.log(`\nSócios: arquivo ${f} concluído`);
  }
}

async function importSimples(client) {
  const db = client.db(DB_NAME);
  const col = db.collection('simples');
  await col.createIndex({ cnpjBasico: 1 }, { unique: true });

  for (const f of listAllFiles(path.join(ROOT, DIRS.simples))) {
    const full = path.join(ROOT, DIRS.simples, f);
    const ops = [];
    const BULK = 1000;

    const flush = async () => {
      if (ops.length) await col.bulkWrite(ops.splice(0), { ordered: false });
    };

    await streamCsvRows(
      full,
      HEADERS.SIMPLES,
      (row, parser) => {
        const base = ensure8(row['CNPJ BÁSICO']);
        if (!base) return;
        ops.push({
          updateOne: {
            filter: { cnpjBasico: base },
            update: {
              $set: {
                cnpjBasico: base,
                opcaoSimples: SN(clean(row['OPÇÃO PELO SIMPLES'])),
                dataOpcaoSimples: clean(row['DATA DE OPÇÃO PELO SIMPLES']) || undefined,
                dataExclusaoSimples: clean(row['DATA DE EXCLUSÃO DO SIMPLES']) || undefined,
                opcaoMei: SN(clean(row['OPÇÃO PELO MEI'])),
                dataOpcaoMei: clean(row['DATA DE OPÇÃO PELO MEI']) || undefined,
                dataExclusaoMei: clean(row['DATA DE EXCLUSÃO DO MEI']) || undefined,
                updatedAt: new Date(),
              },
              $setOnInsert: { createdAt: new Date() },
            },
            upsert: true,
          },
        });

        if (ops.length >= BULK) {
          parser.pause();
          flush().then(() => parser.resume());
        }
      },
      { bulkFlush: flush }
    );
    console.log(`Simples: arquivo ${f} concluído`);
  }
}

/* ================= AGREGADOR ================= */
async function buildEmpresasAgg(client) {
  const db = client.db(DB_NAME);
  const colEmpresas = db.collection('empresas');
  const colEstabs = db.collection('estabelecimentos');
  const colSocios = db.collection('socios');
  const colSimples = db.collection('simples');

  const colNaturezas = db.collection('naturezas');
  const colPaises = db.collection('paises');
  const colMunicipios = db.collection('municipios');
  const colQualif = db.collection('qualificacoes');
  const colCnaes = db.collection('cnaes');
  const colMotivos = db.collection('motivos');

  const colAgg = db.collection('empresas_agg');
  await colAgg.createIndex({ cnpjBasico: 1 }, { unique: true });

  const domToMap = async (col) => {
    const map = new Map();
    for await (const d of col.find({}, { projection: { _id: 0 } })) map.set(d.codigo, d.descricao);
    return map;
  };

  const [mapNaturezas, mapPaises, mapMunicipios, mapQualif, mapCnaes, mapMotivos] = await Promise.all([
    domToMap(colNaturezas),
    domToMap(colPaises),
    domToMap(colMunicipios),
    domToMap(colQualif),
    domToMap(colCnaes),
    domToMap(colMotivos),
  ]);

  const BATCH_SIZE = 1000;
  const CONCURRENCY = 50;
  const limit = pLimit(CONCURRENCY);

  const empresaProj = {
    _id: 0,
    cnpjBasico: 1,
    razaoSocial: 1,
    naturezaCodigo: 1,
    qualificacaoResponsavelCodigo: 1,
    capitalSocial: 1,
    porte: 1,
    enteFederativoResponsavel: 1,
  };

  const cursor = colEmpresas.find({}, { projection: empresaProj, noCursorTimeout: true });

  let processed = 0;
  let batch = [];

  const enrichEstab = (est) => {
    if (est.motivoSituacaoCadastralCodigo)
      est.motivoSituacaoCadastral = {
        codigo: est.motivoSituacaoCadastralCodigo,
        descricao: mapMotivos.get(est.motivoSituacaoCadastralCodigo),
      };
    if (est.paisCodigo) est.pais = { codigo: est.paisCodigo, descricao: mapPaises.get(est.paisCodigo) };
    if (est.endereco?.municipioCodigo)
      est.endereco.municipio = {
        codigo: est.endereco.municipioCodigo,
        descricao: mapMunicipios.get(est.endereco.municipioCodigo),
      };
    if (est.cnaeFiscalPrincipalCodigo)
      est.cnaeFiscalPrincipal = {
        codigo: est.cnaeFiscalPrincipalCodigo,
        descricao: mapCnaes.get(est.cnaeFiscalPrincipalCodigo),
      };
    if (Array.isArray(est.cnaesSecundariosCodigos) && est.cnaesSecundariosCodigos.length) {
      est.cnaesSecundarios = est.cnaesSecundariosCodigos
        .map((c) => ({ codigo: c, descricao: mapCnaes.get(c) }))
        .filter((x) => x.codigo);
    }
    return est;
  };

  const enrichSocio = (s) => {
    if (s.qualificacaoSocioCodigo)
      s.qualificacaoSocio = { codigo: s.qualificacaoSocioCodigo, descricao: mapQualif.get(s.qualificacaoSocioCodigo) };
    if (s.representante?.qualificacaoCodigo)
      s.representante.qualificacao = {
        codigo: s.representante.qualificacaoCodigo,
        descricao: mapQualif.get(s.representante.qualificacaoCodigo),
      };
    if (s.paisCodigo) s.pais = { codigo: s.paisCodigo, descricao: mapPaises.get(s.paisCodigo) };
    return s;
  };

  const processOne = async (e) => {
    const base = e.cnpjBasico;

    const [estabelecimentos, socios, simples] = await Promise.all([
      colEstabs.find({ cnpjBasico: base }, { projection: { _id: 0 } }).toArray(),
      colSocios.find({ cnpjBasico: base }, { projection: { _id: 0 } }).toArray(),
      colSimples.findOne({ cnpjBasico: base }, { projection: { _id: 0 } }),
    ]);

    const estEnriquecidos = (estabelecimentos || []).map(enrichEstab);
    const sociosEnriquecidos = (socios || []).map(enrichSocio);

    const empresaAgg = {
      cnpjBasico: base,
      razaoSocial: e.razaoSocial,
      natureza: e.naturezaCodigo
        ? { codigo: e.naturezaCodigo, descricao: mapNaturezas.get(e.naturezaCodigo) }
        : undefined,
      qualificacaoResponsavel: e.qualificacaoResponsavelCodigo
        ? { codigo: e.qualificacaoResponsavelCodigo, descricao: mapQualif.get(e.qualificacaoResponsavelCodigo) }
        : undefined,
      capitalSocial: e.capitalSocial,
      porte: e.porte,
      enteFederativoResponsavel: e.enteFederativoResponsavel,
      estabelecimentos: estEnriquecidos,
      socios: sociosEnriquecidos,
      simples: simples || undefined,
      updatedAt: new Date(),
    };

    return {
      updateOne: {
        filter: { cnpjBasico: base },
        update: { $set: empresaAgg, $setOnInsert: { createdAt: new Date() } },
        upsert: true,
      },
    };
  };

  const flushBatch = async (ops) => {
    if (!ops.length) return;
    await colAgg.bulkWrite(ops, { ordered: false });
  };

  while (await cursor.hasNext()) {
    const e = await cursor.next();
    batch.push(e);

    if (batch.length >= BATCH_SIZE) {
      const ops = await Promise.all(batch.map((empresa) => limit(() => processOne(empresa))));
      await flushBatch(ops);
      processed += batch.length;
      process.stdout.write(`empresas_agg: ${processed}\r`);
      batch = [];
    }
  }

  if (batch.length) {
    const ops = await Promise.all(batch.map((empresa) => limit(() => processOne(empresa))));
    await flushBatch(ops);
    processed += batch.length;
    process.stdout.write(`empresas_agg: ${processed}\r`);
  }

  console.log(`\nempresas_agg finalizado: ${processed} empresas agregadas`);
}

/* ================= RUN ================= */
async function run() {
  // Garante estrutura de pastas
  await Promise.all(
    Object.values(DIRS).map((d) => fs.promises.mkdir(path.join(ROOT, d), { recursive: true }))
  );

  console.log('> Buscando mês mais recente e baixando arquivos...');
  await fetchLatestMonthAndExtract();

  const client = new MongoClient(MONGO_URI, {
    maxPoolSize: 5,
    socketTimeoutMS: SOCKET_TIMEOUT_MS,
    connectTimeoutMS: SOCKET_TIMEOUT_MS,
    dbName: DB_NAME,
  });
  await client.connect();

  console.log('> Importando domínios...');
  await importDom2(client, 'naturezas', DIRS.naturezas);
  await importDom2(client, 'municipios', DIRS.municipios);
  await importDom2(client, 'paises', DIRS.paises);
  await importDom2(client, 'qualificacoes', DIRS.qualificacoes);
  await importDom2(client, 'cnaes', DIRS.cnaes);
  await importDom2(client, 'motivos', DIRS.motivos);

  console.log('> Importando tabelas grandes (com upsert)...');
  await importEmpresas(client);
  await importEstabelecimentos(client);
  await importSocios(client);
  await importSimples(client);

  console.log('> Construindo empresas_agg...');
  await buildEmpresasAgg(client);

  await client.close();
  console.log('✅ Tudo concluído.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
