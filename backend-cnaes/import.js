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

// Pasta onde você já tem todos os .zip baixados da Receita Federal
const LOCAL_ZIPS_DIR = path.resolve(process.env.LOCAL_ZIPS_DIR || './zips_cnpj');

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
const PORTE_MAP = {
  '1': 'Não informado', '01': 'Não informado',
  '2': 'Micro Empresa', '02': 'Micro Empresa',
  '3': 'Empresa de Pequeno Porte', '03': 'Empresa de Pequeno Porte',
  '5': 'Demais', '05': 'Demais',
};

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
      .then((v) => { resolve(v); next(); })
      .catch((e) => { reject(e); next(); });
  };
  return (fn) =>
    new Promise((res, rej) => {
      const task = () => run(fn, res, rej);
      active < concurrency ? task() : queue.push(task);
    });
};

/* =============== EXTRAÇÃO LOCAL DOS ZIPS =============== */
async function extractAllLocalZips() {
  if (!fs.existsSync(LOCAL_ZIPS_DIR)) {
    throw new Error(`Pasta com ZIPs não encontrada: ${LOCAL_ZIPS_DIR}\nDefina LOCAL_ZIPS_DIR no .env ou coloque os arquivos lá.`);
  }

  const zipFiles = fs.readdirSync(LOCAL_ZIPS_DIR)
    .filter(f => /\.zip$/i.test(f))
    .map(f => path.join(LOCAL_ZIPS_DIR, f));

  if (zipFiles.length === 0) {
    throw new Error(`Nenhum arquivo .zip encontrado em ${LOCAL_ZIPS_DIR}`);
  }

  console.log(`Encontrados ${zipFiles.length} arquivos ZIP em ${LOCAL_ZIPS_DIR}`);

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

  const limit = pLimit(4);

  await Promise.all(
    zipFiles.map(zipPath =>
      limit(async () => {
        const fileName = path.basename(zipPath);
        const destSub = routeFor(fileName);
        const destDir = destSub ? path.join(ROOT, destSub) : ROOT;

        console.log(`Extraindo: ${fileName} → ${path.relative('.', destDir)}`);
        await extractZip(zipPath, destDir);
      })
    )
  );

  console.log('Todos os ZIPs locais foram extraídos com sucesso.');
}

async function extractZip(zipPath, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);

  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;

    const baseName = path.basename(entry.path).replace(/[/\\]+/g, '');
    const outName = /\.csv$/i.test(baseName) ? baseName : `${baseName}.csv`;
    const outPath = path.join(destDir, outName);

    const readStream = entry.stream();
    const writeStream = fs.createWriteStream(outPath);
    await pipeline(readStream, writeStream);
  }
}

/* =============== RETRY HELPER =============== */
function isRetryableError(err) {
  const msg = (err.message || '') + ' ' + (err.errorResponse?.message || '');
  const retryablePatterns = [
    'ECONNRESET', 'network', 'ETIMEDOUT', 'timeout', 'timed out',
    'PoolCleared', 'PoolRequstedRetry', 'interrupted', 'socket',
    'connection closed', 'topology was destroyed',
  ];
  if (retryablePatterns.some(p => msg.toLowerCase().includes(p.toLowerCase()))) return true;
  if (err.codeName === 'NetworkTimeout') return true;
  if (err.name === 'MongoNetworkError' || err.name === 'MongoNetworkTimeoutError') return true;
  if (err.errorLabels?.includes('RetryableWriteError')) return true;
  if (err.errorLabelSet?.has('PoolRequstedRetry')) return true;
  return false;
}

async function bulkWriteWithRetry(col, ops, maxRetries = 15) {
  const batch = ops.splice(0);
  for (let tentativa = 1; tentativa <= maxRetries; tentativa++) {
    try {
      await col.bulkWrite(batch, { ordered: false });
      return;
    } catch (err) {
      if (isRetryableError(err)) {
        console.log(`Conexão caiu (tentativa ${tentativa}/${maxRetries}). Reconectando em ${tentativa * 5}s...`);
        await new Promise(r => setTimeout(r, tentativa * 5000));
      } else {
        ops.unshift(...batch);
        throw err;
      }
    }
  }
  ops.unshift(...batch);
  throw new Error(`Falha após ${maxRetries} tentativas de reconexão`);
}

/* =============== CSV READER HELPERS =============== */
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

function socioIdHash(row) {
  const key = [
    row['CNPJ BÁSICO'],
    row['IDENTIFICADOR DE SÓCIO'],
    row['CNPJ/CPF DO SÓCIO'],
    row['NOME DO SÓCIO (NO CASO PF) OU RAZÃO SOCIAL (NO CASO PJ)'],
    row['DATA DE ENTRADA SOCIEDADE'],
  ].map(x => (x ?? '').toString()).join('|');
  return crypto.createHash('sha1').update(key).digest('hex');
}

/* =============== IMPORTADORES =============== */
async function importDom2(client, collName, subdir) {
  const db = client.db(DB_NAME);
  const col = db.collection(collName);

  const forceRefresh = process.env.FORCE_DOMAIN_REFRESH === '1';
  const count = await col.estimatedDocumentCount();
  if (count > 0 && !forceRefresh) {
    console.log(`Domínio ${collName} já importado (${count} registros). Pulando... (use FORCE_DOMAIN_REFRESH=1 para atualizar)`);
    return;
  }

  if (forceRefresh && count > 0) {
    console.log(`Domínio ${collName}: limpando ${count} registros antigos para reimportação...`);
    await col.deleteMany({});
  }

  await col.createIndex({ codigo: 1 }, { unique: true, background: true });

  const folder = path.join(ROOT, subdir);
  for (const f of listAllFiles(folder)) {
    const full = path.join(folder, f);
    const ops = [];
    const BULK = 1000;

    const flush = async () => {
      if (ops.length === 0) return;
      await bulkWriteWithRetry(col, ops);
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
          flush().then(() => parser.resume()).catch(err => parser.emit('error', err));
        }
      },
      { bulkFlush: flush }
    );
    console.log(`Domínio ${collName}: ${f} importado com sucesso`);
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
      if (ops.length === 0) return;
      await bulkWriteWithRetry(col, ops);
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
          flush().then(() => parser.resume()).catch(err => parser.emit('error', err));
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

  // 1. Remove índice legado "cnpj_1" que causa E11000 duplicate key
  try {
    const indexes = await col.indexes();
    const hasLegacyCnpjIndex = indexes.some(idx => idx.name === 'cnpj_1');
    if (hasLegacyCnpjIndex) {
      await col.dropIndex('cnpj_1');
      console.log('Índice legado "cnpj_1" removido → E11000 resolvido');
    }
  } catch (err) {
    if (err.codeName !== 'IndexNotFound') {
      console.warn('Aviso ao tentar remover índice cnpj_1:', err.message);
    }
  }

  // 2. Índices úteis
  await col.createIndex({ cnpjBasico: 1 }, { background: true });

  // 3. Importação
  for (const f of listAllFiles(path.join(ROOT, DIRS.estab))) {
    const full = path.join(ROOT, DIRS.estab, f);
    let count = 0;
    const ops = [];
    const BULK = 1000;

    const flush = async () => {
      if (ops.length === 0) return;

      const currentBatch = ops.splice(0);

      for (let tentativa = 1; tentativa <= 15; tentativa++) {
        try {
          await col.bulkWrite(currentBatch, { ordered: false });
          return; // sucesso
        } catch (err) {
          if (
            err.message?.includes('ECONNRESET') ||
            err.message?.includes('network') ||
            err.message?.includes('ETIMEDOUT') ||
            err.codeName === 'NetworkTimeout' ||
            err.name === 'MongoNetworkError'
          ) {
            console.log(`Conexão caiu (tentativa ${tentativa}/15). Reconectando em ${tentativa * 5}s...`);
            await new Promise(r => setTimeout(r, tentativa * 5000));
          } else {
            ops.unshift(...currentBatch);
            throw err;
          }
        }
      }

      ops.unshift(...currentBatch);
      throw new Error('Falha após 15 tentativas de reconexão');
    };

    console.log(`Importando estabelecimentos: ${f}`);

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
          situacaoCadastral: clean(row['SITUAÇÃO CADASTRAL']) || undefined,
          dataSituacaoCadastral: clean(row['DATA SITUAÇÃO CADASTRAL']) || undefined,
          motivoSituacaoCadastralCodigo: clean(row['MOTIVO SITUAÇÃO CADASTRAL']) || undefined,
          paisCodigo: clean(row['PAIS']) || undefined,
          dataInicioAtividade: clean(row['DATA DE INÍCIO ATIVIDADE']) || undefined,
          cnaeFiscalPrincipalCodigo: clean(row['CNAE FISCAL PRINCIPAL']) || undefined,
          cnaesSecundariosCodigos: clean(row['CNAE FISCAL SECUNDÁRIA'])
            ? clean(row['CNAE FISCAL SECUNDÁRIA']).split(',').map(s => s.trim()).filter(Boolean)
            : [],
          endereco: {
            tipoLogradouro: clean(row['TIPO DE LOGRADOURO']) || undefined,
            logradouro: clean(row['LOGRADOURO']) || undefined,
            numero: clean(row['NÚMERO']) || undefined,
            complemento: clean(row['COMPLEMENTO']) || undefined,
            bairro: clean(row['BAIRRO']) || undefined,
            cep: clean(row['CEP']) || undefined,
            uf: clean(row['UF']) || undefined,
            municipioCodigo: clean(row['MUNICÍPIO']) || undefined,
          },
          telefones: [
            clean(row['DDD 1']) && clean(row['TELEFONE 1']) ? `${clean(row['DDD 1'])}${clean(row['TELEFONE 1'])}` : null,
            clean(row['DDD 2']) && clean(row['TELEFONE 2']) ? `${clean(row['DDD 2'])}${clean(row['TELEFONE 2'])}` : null,
          ].filter(Boolean),
          email: clean(row['CORREIO ELETRÔNICO']) || undefined,
          situacaoEspecial: clean(row['SITUAÇÃO ESPECIAL']) || undefined,
          dataSituacaoEspecial: clean(row['DATA DA SITUAÇÃO ESPECIAL']) || undefined,
          updatedAt: new Date(),
        };

        ops.push({
          updateOne: {
            filter: { _id: cnpj },
            update: { $set: doc, $setOnInsert: { createdAt: new Date() } },
            upsert: true,
          },
        });

        if (++count % 25_000 === 0) {
          process.stdout.write(`  Estabelecimentos processados: ${count.toLocaleString()}   \r`);
        }

        if (ops.length >= BULK) {
          parser.pause();
          flush().then(() => parser.resume()).catch(err => parser.emit('error', err));
        }
      },
      { bulkFlush: flush }
    );

    await flush();

    console.log(`\nEstabelecimentos: ${f} → ${count.toLocaleString()} registros importados`);
  }

  console.log('Importação de estabelecimentos concluída com sucesso!');
}

async function importSocios(client) {
  const db = client.db(DB_NAME);
  const col = db.collection('socios');
  const statusCol = db.collection('import_status'); // controle de arquivos concluídos

  await col.createIndex({ cnpjBasico: 1 });

  for (const f of listAllFiles(path.join(ROOT, DIRS.socios))) {
    // Verifica se este arquivo já foi concluído em uma execução anterior
    const already = await statusCol.findOne({ collection: 'socios', file: f, done: true });
    if (already) {
      console.log(`Sócios: pulando arquivo ${f}, já importado anteriormente.`);
      continue;
    }

    const full = path.join(ROOT, DIRS.socios, f);
    let count = 0;
    const ops = [];
    const BULK = 1000;

    const flush = async () => {
      if (ops.length === 0) return;
      await bulkWriteWithRetry(col, ops);
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
          flush().then(() => parser.resume()).catch(err => parser.emit('error', err));
        }
      },
      { bulkFlush: flush }
    );

    await flush();
    console.log(`\nSócios: arquivo ${f} concluído`);

    // Marca o arquivo como concluído
    await statusCol.updateOne(
      { collection: 'socios', file: f },
      {
        $set: {
          collection: 'socios',
          file: f,
          done: true,
          finishedAt: new Date(),
        },
      },
      { upsert: true }
    );
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
      if (ops.length === 0) return;
      await bulkWriteWithRetry(col, ops);
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
          flush().then(() => parser.resume()).catch(err => parser.emit('error', err));
        }
      },
      { bulkFlush: flush }
    );
    await flush();
    console.log(`Simples: arquivo ${f} concluído`);
  }
}

/* =============== AGREGAÇÃO FINAL =============== */
async function buildEmpresasAgg(client) {
  console.log('> Construindo coleção agregada (empresas_agg) — versão indestrutível ativada');

  const db = client.db(DB_NAME);
  const colAgg = db.collection('empresas_agg');

  // Se já tem mais de 100k documentos, pula (você já fez)
  if (await colAgg.estimatedDocumentCount() > 100000) {
    console.log('empresas_agg já existe com muitos documentos → pulando');
    return;
  }

  await colAgg.drop().catch(() => {});
  await colAgg.createIndex({ cnpjBasico: 1 }, { unique: true });

  // Carrega domínios (com retry)
  const loadMap = async (collName) => {
    const map = new Map();
    for (let i = 0; i < 50; i++) {
      try {
        for await (const doc of db.collection(collName).find({}, { projection: { codigo: 1, descricao: 1, _id: 0 } })) {
          if (doc.codigo) map.set(doc.codigo, doc.descricao || '');
        }
        return map;
      } catch (err) {
        console.log(`Erro ao carregar ${collName}, tentativa ${i + 1}/50...`);
        await new Promise(r => setTimeout(r, 10000));
      }
    }
    throw new Error(`Falha ao carregar ${collName}`);
  };

  console.log('Carregando domínios (naturezas, municípios, etc.)...');
  const [mapNat, mapPais, mapMun, mapQual, mapCnae, mapMot] = await Promise.all([
    loadMap('naturezas'),
    loadMap('paises'),
    loadMap('municipios'),
    loadMap('qualificacoes'),
    loadMap('cnaes'),
    loadMap('motivos'),
  ]);

  const colEmpresas = db.collection('empresas');
  const colEstabs = db.collection('estabelecimentos');
  const colSocios = db.collection('socios');
  const colSimples = db.collection('simples');

  let processed = 0;
  const BATCH_SIZE = 500;

  const cursor = colEmpresas.find({}, { 
    projection: { 
      cnpjBasico: 1, razaoSocial: 1, naturezaCodigo: 1, 
      qualificacaoResponsavelCodigo: 1, capitalSocial: 1, 
      porte: 1, enteFederativoResponsavel: 1 
    }, 
    noCursorTimeout: true 
  }).batchSize(1000);

  const safeFind = async (col, filter) => {
    for (let i = 0; i < 30; i++) {
      try {
        return await col.find(filter).toArray();
      } catch (err) {
        console.log(`Erro no find (tentativa ${i + 1}), reconectando...`);
        await new Promise(r => setTimeout(r, (i + 1) * 5000));
        client = await getClient(); // força reconexão global
      }
    }
    return [];
  };

  const safeFindOne = async (col, filter) => {
    for (let i = 0; i < 20; i++) {
      try {
        return await col.findOne(filter);
      } catch (err) {
        console.log(`Erro no findOne (tentativa ${i + 1})...`);
        await new Promise(r => setTimeout(r, 8000));
      }
    }
    return null;
  };

  while (await cursor.hasNext()) {
    const batch = [];
    for (let i = 0; i < BATCH_SIZE && await cursor.hasNext(); i++) {
      batch.push(await cursor.next());
    }

    const ops = [];
    for (const empresa of batch) {
      const base = empresa.cnpjBasico;

      const [estabs, socios, simples] = await Promise.all([
        safeFind(colEstabs, { cnpjBasico: base }),
        safeFind(colSocios, { cnpjBasico: base }),
        safeFindOne(colSimples, { cnpjBasico: base }),
      ]);

      // Enriquecimento (sem falhar)
      const estEnriq = (estabs || []).map(e => {
        e.endereco ||= {};
        e.endereco.municipio = e.endereco.municipioCodigo ? { codigo: e.endereco.municipioCodigo, descricao: mapMun.get(e.endereco.municipioCodigo) || 'Não encontrado' } : null;
        e.cnaeFiscalPrincipal = e.cnaeFiscalPrincipalCodigo ? { codigo: e.cnaeFiscalPrincipalCodigo, descricao: mapCnae.get(e.cnaeFiscalPrincipalCodigo) || 'Não encontrado' } : null;
        return e;
      });

      const aggDoc = {
        cnpjBasico: base,
        razaoSocial: empresa.razaoSocial || 'NÃO INFORMADO',
        natureza: empresa.naturezaCodigo ? { codigo: empresa.naturezaCodigo, descricao: mapNat.get(empresa.naturezaCodigo) || 'Não encontrado' } : null,
        capitalSocial: empresa.capitalSocial,
        porte: empresa.porte,
        enteFederativoResponsavel: empresa.enteFederativoResponsavel,
        estabelecimentos: estEnriq,
        socios: (socios || []).map(s => ({
          ...s,
          qualificacaoSocio: s.qualificacaoSocioCodigo ? { codigo: s.qualificacaoSocioCodigo, descricao: mapQual.get(s.qualificacaoSocioCodigo) || 'Não encontrado' } : null,
        })),
        simples: simples || null,
        updatedAt: new Date(),
      };

      ops.push({
        updateOne: {
          filter: { cnpjBasico: base },
          update: { $set: aggDoc },
          upsert: true,
        },
      });
    }

    // Flush com retry
    for (let t = 0; t < 20; t++) {
      try {
        await colAgg.bulkWrite(ops, { ordered: false });
        break;
      } catch (err) {
        console.log(`Erro no bulkWrite da agregação (tentativa ${t + 1}/20), reconectando...`);
        await new Promise(r => setTimeout(r, (t + 1) * 10000));
        client = await getClient();
      }
    }

    processed += batch.length;
    process.stdout.write(`empresas_agg: ${processed.toLocaleString()} empresas processadas\r`);
  }

  console.log(`\nAGREGAÇÃO CONCLUÍDA: ${processed.toLocaleString()} empresas em empresas_agg`);
}

/* =============== ATUALIZAÇÃO INCREMENTAL DA empresas_agg (SÓ O QUE FALTA) =============== */
/* ================= CLIENTE COM RECONEXÃO INFINITA (OBRIGATÓRIO) ================= */
let globalClient = null;
async function getClient() {
  if (globalClient?.topology?.isConnected()) return globalClient;
  if (globalClient) await globalClient.close().catch(() => {});

  while (true) {
    try {
      globalClient = new MongoClient(MONGO_URI, {
        maxPoolSize: 5,
        minPoolSize: 1,
        maxIdleTimeMS: 0,
        connectTimeoutMS: 30000,
        socketTimeoutMS: 0,
        serverSelectionTimeoutMS: 30000,
        heartbeatFrequencyMS: 10000,
        retryWrites: true,
        retryReads: true,
      });
      await globalClient.connect();
      console.log('MongoDB reconectado com sucesso!');
      return globalClient;
    } catch (err) {
      console.log('Falha na conexão. Tentando novamente em 15 segundos...');
      await new Promise(r => setTimeout(r, 15000));
    }
  }
}

/* =============== ATUALIZAÇÃO INCREMENTAL (via left anti-join com cursor) =============== */
async function updateEmpresasAgg() {
  console.log('INICIANDO ATUALIZAÇÃO INCREMENTAL DA empresas_agg');

  let client = await getClient();
  let processed = 0;
  let inserted = 0;

  const loadMapWithRetry = async (collName) => {
    const map = new Map();
    while (true) {
      try {
        client = await getClient();
        const col = client.db(DB_NAME).collection(collName);
        for await (const doc of col.find({}, { projection: { codigo: 1, descricao: 1, _id: 0 } })) {
          if (doc.codigo) map.set(doc.codigo, doc.descricao || 'Não encontrado');
        }
        console.log(`  ${collName}: ${map.size} itens`);
        return map;
      } catch (err) {
        console.log(`Erro ao carregar ${collName}. Reconectando...`);
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  };

  console.log('Carregando domínios...');
  const [mapNat, mapMun, mapQual, mapCnae, mapPais, mapMot] = await Promise.all([
    loadMapWithRetry('naturezas'),
    loadMapWithRetry('municipios'),
    loadMapWithRetry('qualificacoes'),
    loadMapWithRetry('cnaes'),
    loadMapWithRetry('paises'),
    loadMapWithRetry('motivos'),
  ]);

  const BATCH_SIZE = 500;
  let lastCnpj = '';

  while (true) {
    try {
      client = await getClient();
      const db = client.db(DB_NAME);

      // Usa $lookup (left anti-join) para encontrar empresas que nao estao na agg
      // Muito mais eficiente que distinct() + $nin
      const pipeline = [
        ...(lastCnpj ? [{ $match: { cnpjBasico: { $gt: lastCnpj } } }] : []),
        { $sort: { cnpjBasico: 1 } },
        { $limit: BATCH_SIZE },
        {
          $lookup: {
            from: 'empresas_agg',
            localField: 'cnpjBasico',
            foreignField: 'cnpjBasico',
            as: '_existing',
            pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }],
          },
        },
        { $match: { _existing: { $size: 0 } } },
        {
          $project: {
            cnpjBasico: 1, razaoSocial: 1, naturezaCodigo: 1,
            qualificacaoResponsavelCodigo: 1, capitalSocial: 1,
            porte: 1, enteFederativoResponsavel: 1,
          },
        },
      ];

      const batch = await db.collection('empresas').aggregate(pipeline, { allowDiskUse: true }).toArray();

      if (batch.length === 0) {
        // Pode ser que todas do batch ja existam — avançar o cursor
        const nextBatch = await db.collection('empresas')
          .find(lastCnpj ? { cnpjBasico: { $gt: lastCnpj } } : {})
          .sort({ cnpjBasico: 1 })
          .limit(1)
          .project({ cnpjBasico: 1 })
          .toArray();

        if (nextBatch.length === 0) {
          console.log('\nTUDO ATUALIZADO! Todas as empresas estão na empresas_agg');
          break;
        }

        // Avança o cursor pulando as que ja existem
        const skipBatch = await db.collection('empresas')
          .find(lastCnpj ? { cnpjBasico: { $gt: lastCnpj } } : {})
          .sort({ cnpjBasico: 1 })
          .limit(BATCH_SIZE)
          .project({ cnpjBasico: 1 })
          .toArray();

        if (skipBatch.length > 0) {
          lastCnpj = skipBatch[skipBatch.length - 1].cnpjBasico;
          processed += skipBatch.length;
          process.stdout.write(`Varridas: ${processed.toLocaleString()} | Inseridas: ${inserted.toLocaleString()}   \r`);
        }
        continue;
      }

      lastCnpj = batch[batch.length - 1].cnpjBasico;
      const ops = [];

      for (const emp of batch) {
        const base = emp.cnpjBasico;

        const [estabs, socios, simples] = await Promise.all([
          db.collection('estabelecimentos').find({ cnpjBasico: base }).toArray().catch(() => []),
          db.collection('socios').find({ cnpjBasico: base }).toArray().catch(() => []),
          db.collection('simples').findOne({ cnpjBasico: base }).catch(() => null),
        ]);

        const aggDoc = {
          cnpjBasico: base,
          razaoSocial: emp.razaoSocial || 'NÃO INFORMADO',
          natureza: emp.naturezaCodigo ? { codigo: emp.naturezaCodigo, descricao: mapNat.get(emp.naturezaCodigo) } : null,
          capitalSocial: emp.capitalSocial,
          porte: emp.porte,
          enteFederativoResponsavel: emp.enteFederativoResponsavel,
          estabelecimentos: (estabs || []).map(e => ({
            ...e,
            endereco: {
              ...e.endereco,
              municipio: e.endereco?.municipioCodigo ? { codigo: e.endereco.municipioCodigo, descricao: mapMun.get(e.endereco.municipioCodigo) } : null
            },
            cnaeFiscalPrincipal: e.cnaeFiscalPrincipalCodigo ? { codigo: e.cnaeFiscalPrincipalCodigo, descricao: mapCnae.get(e.cnaeFiscalPrincipalCodigo) } : null
          })),
          socios: (socios || []).map(s => ({
            ...s,
            qualificacaoSocio: s.qualificacaoSocioCodigo ? { codigo: s.qualificacaoSocioCodigo, descricao: mapQual.get(s.qualificacaoSocioCodigo) } : null
          })),
          simples: simples || null,
          updatedAt: new Date(),
        };

        ops.push({
          replaceOne: {
            filter: { cnpjBasico: base },
            replacement: aggDoc,
            upsert: true,
          },
        });

        inserted++;
      }

      for (let t = 0; t < 20; t++) {
        try {
          await db.collection('empresas_agg').bulkWrite(ops, { ordered: false });
          break;
        } catch (err) {
          console.log(`Erro no bulkWrite (tentativa ${t + 1}/20). Reconectando...`);
          await new Promise(r => setTimeout(r, (t + 1) * 5000));
          client = await getClient();
        }
      }

      processed += batch.length;
      process.stdout.write(`Varridas: ${processed.toLocaleString()} | Inseridas: ${inserted.toLocaleString()}   \r`);

    } catch (err) {
      console.log(`\nErro geral: ${err.message}. Reconectando em 15s...`);
      await new Promise(r => setTimeout(r, 15000));
    }
  }

  console.log(`\nAGREGAÇÃO CONCLUÍDA: ${inserted.toLocaleString()} novas empresas adicionadas à empresas_agg`);
}

/* ================= RUN ================= */
async function run() {
  await Promise.all(
    Object.values(DIRS).map((d) => fs.promises.mkdir(path.join(ROOT, d), { recursive: true }))
  );

  const SKIP_EXTRACT = process.env.SKIP_EXTRACT === '1';
  const SKIP_IMPORT = process.env.SKIP_IMPORT === '1';
  const SKIP_AGG = process.env.SKIP_AGG === '1';

  if (!SKIP_EXTRACT) {
    console.log('> Extraindo todos os ZIPs locais...');
    await extractAllLocalZips();
  } else {
    console.log('> Extração pulada (SKIP_EXTRACT=1)');
  }

  const client = new MongoClient(MONGO_URI, {
    maxPoolSize: 20,
    minPoolSize: 10,
    maxIdleTimeMS: 0,
    socketTimeoutMS: 0,
    connectTimeoutMS: 300000,
    serverSelectionTimeoutMS: 30000,
    heartbeatFrequencyMS: 10000,
    retryWrites: true,
    retryReads: true,
    compressors: ['zlib'],
  });
  await client.connect();

  console.log('> Importando domínios...');
  await importDom2(client, 'naturezas', DIRS.naturezas);
  await importDom2(client, 'municipios', DIRS.municipios);
  await importDom2(client, 'paises', DIRS.paises);
  await importDom2(client, 'qualificacoes', DIRS.qualificacoes);
  await importDom2(client, 'cnaes', DIRS.cnaes);
  await importDom2(client, 'motivos', DIRS.motivos);

  if (!SKIP_IMPORT) {
    console.log('> Importando tabelas principais...');
    await importEmpresas(client);
    await importEstabelecimentos(client);
    await importSocios(client);
    await importSimples(client);
  } else {
    console.log('> Importação de tabelas pulada (SKIP_IMPORT=1)');
  }

  if (!SKIP_AGG) {
    console.log('> Construindo coleção agregada (empresas_agg)...');
    await updateEmpresasAgg();
  } else {
    console.log('> Agregação pulada (SKIP_AGG=1)');
  }

  console.log('Tudo concluído com sucesso!');
}

run().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
