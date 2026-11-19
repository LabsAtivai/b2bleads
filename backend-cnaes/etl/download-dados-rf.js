/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import unzipper from 'unzipper';
import dotenv from 'dotenv';

dotenv.config();

/* ============================================================
   CONFIGURAÇÃO
   ============================================================ */

// Share público da Receita Federal (Nextcloud/SERPRO+)
const SHARE_TOKEN = process.env.RF_SHARE_TOKEN || 'gn672Ad4CF8N6TK';
const WEBDAV_HOST = 'arquivos.receitafederal.gov.br';
const WEBDAV_BASE = `https://${WEBDAV_HOST}/public.php/webdav`;
const CNPJ_DIR = 'Dados/Cadastros/CNPJ';

export const ZIPS_ROOT = path.resolve(process.env.LOCAL_ZIPS_DIR || './zips_cnpj');

// Arquivo usado como sonda para saber se um período já foi publicado.
const PROBE_FILE = 'Cnaes.zip';
const PROBE_MONTHS_BACK = Number(process.env.RF_PROBE_MONTHS || 4);

export const FILES = [
  'Cnaes.zip',
  'Motivos.zip',
  'Municipios.zip',
  'Naturezas.zip',
  'Paises.zip',
  'Qualificacoes.zip',
  'Simples.zip',
  ...Array.from({ length: 10 }, (_, i) => `Empresas${i}.zip`),
  ...Array.from({ length: 10 }, (_, i) => `Estabelecimentos${i}.zip`),
  ...Array.from({ length: 10 }, (_, i) => `Socios${i}.zip`),
];

const authHeader = () => `Basic ${Buffer.from(`${SHARE_TOKEN}:`).toString('base64')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const remoteUrl = (periodo, fileName) => `${WEBDAV_BASE}/${CNPJ_DIR}/${periodo}/${fileName}`;

/* ============================================================
   DETECÇÃO DO PERÍODO MAIS RECENTE
   ============================================================ */

function periodosCandidatos(now = new Date()) {
  const out = [];
  for (let i = 0; i < PROBE_MONTHS_BACK; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// HEAD no arquivo-sonda. Só 200 indica período publicado; 404 = não existe.
function probe(periodo) {
  return new Promise((resolve, reject) => {
    const url = new URL(remoteUrl(periodo, PROBE_FILE));
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'HEAD',
        headers: { Authorization: authHeader() },
        timeout: 30000,
      },
      (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        if (res.statusCode === 404) return resolve(false);
        reject(new Error(`HTTP ${res.statusCode} ao sondar ${periodo}`));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout ao sondar período')));
    req.end();
  });
}

/** Retorna 'YYYY-MM' do período mais novo publicado, ou null. */
export async function detectLatestPeriodo() {
  for (const periodo of periodosCandidatos()) {
    try {
      if (await probe(periodo)) return periodo;
    } catch (err) {
      // Falha de rede não pode ser confundida com "não publicado".
      throw new Error(`Não foi possível sondar ${periodo}: ${err.message}`);
    }
  }
  return null;
}

/* ============================================================
   DOWNLOAD
   ============================================================ */

function cleanup(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* noop */ }
}

// Valida estrutura do ZIP (central directory). Pega arquivo truncado.
async function isValidZip(filePath) {
  try {
    const dir = await unzipper.Open.file(filePath);
    return dir.files.length > 0;
  } catch {
    return false;
  }
}

function downloadFile(periodo, fileName, destPath) {
  const tmpPath = `${destPath}.tmp`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, bytes) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(bytes);
    };

    cleanup(tmpPath);
    const file = fs.createWriteStream(tmpPath);
    const fail = (err) => {
      file.destroy();
      cleanup(tmpPath);
      done(err);
    };

    const doRequest = (requestUrl, redirectCount = 0) => {
      if (redirectCount > 10) return fail(new Error('Muitos redirecionamentos'));

      const urlObj = new URL(requestUrl);
      const headers = {};
      // Credencial só vai para o host da Receita; nunca reenviada em redirect externo.
      if (urlObj.hostname === WEBDAV_HOST) headers.Authorization = authHeader();

      const req = https.request(
        {
          hostname: urlObj.hostname,
          port: 443,
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          headers,
          timeout: 300000,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return doRequest(new URL(res.headers.location, requestUrl).toString(), redirectCount + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return fail(new Error(`HTTP ${res.statusCode}`));
          }

          const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
          let downloaded = 0;
          let lastPrint = 0;

          res.on('data', (chunk) => {
            downloaded += chunk.length;
            const now = Date.now();
            if (now - lastPrint > 5000) {
              lastPrint = now;
              const mb = (downloaded / 1048576).toFixed(1);
              const pct = totalBytes ? ` (${((downloaded / totalBytes) * 100).toFixed(1)}%)` : '';
              console.log(`  ${fileName}: ${mb}MB${pct}`);
            }
          });
          res.on('error', fail);
          res.on('aborted', () => fail(new Error('Conexão abortada pelo servidor')));

          res.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              if (settled) return;
              if (totalBytes && downloaded !== totalBytes) {
                return fail(new Error(`Tamanho divergente: recebido ${downloaded}, esperado ${totalBytes}`));
              }
              try {
                fs.renameSync(tmpPath, destPath);
              } catch (renameErr) {
                return fail(renameErr);
              }
              done(null, downloaded);
            });
          });
          file.on('error', fail);
        }
      );

      req.on('error', fail);
      req.on('timeout', () => req.destroy(new Error('Timeout (5min)')));
      req.end();
    };

    doRequest(remoteUrl(periodo, fileName));
  });
}

/**
 * Baixa todos os ZIPs do período para ZIPS_ROOT/<periodo>/.
 * Arquivos já presentes e válidos são reaproveitados.
 * Lança erro se qualquer arquivo falhar (carga parcial não pode seguir).
 */
export async function downloadPeriodo(periodo) {
  const destDir = path.join(ZIPS_ROOT, periodo);
  fs.mkdirSync(destDir, { recursive: true });

  console.log(`Download período ${periodo} → ${destDir} (${FILES.length} arquivos)`);

  let ok = 0;
  let reused = 0;
  let totalBytes = 0;
  const errors = [];

  for (let i = 0; i < FILES.length; i++) {
    const fileName = FILES[i];
    const destPath = path.join(destDir, fileName);

    if (fs.existsSync(destPath) && (await isValidZip(destPath))) {
      reused++;
      totalBytes += fs.statSync(destPath).size;
      console.log(`[${i + 1}/${FILES.length}] ${fileName}: já existe e é válido`);
      continue;
    }
    cleanup(destPath);

    console.log(`[${i + 1}/${FILES.length}] Baixando ${fileName}...`);
    let success = false;
    for (let tentativa = 1; tentativa <= 4 && !success; tentativa++) {
      try {
        const bytes = await downloadFile(periodo, fileName, destPath);
        if (!(await isValidZip(destPath))) {
          cleanup(destPath);
          throw new Error('ZIP inválido após download');
        }
        totalBytes += bytes;
        ok++;
        success = true;
      } catch (err) {
        console.error(`  ERRO (tentativa ${tentativa}/4): ${err.message}`);
        if (tentativa < 4) await sleep(tentativa * 15000);
        else errors.push({ fileName, error: err.message });
      }
    }
  }

  console.log(`Download: ${ok} baixados | ${reused} reaproveitados | ${errors.length} falhas | ${(totalBytes / 1073741824).toFixed(2)}GB`);

  if (errors.length) {
    throw new Error(`Falha no download de ${errors.length} arquivo(s): ${errors.map((e) => `${e.fileName} (${e.error})`).join('; ')}`);
  }
  return { periodo, dir: destDir, files: FILES.length, bytes: totalBytes };
}

/* ============================================================
   CLI: node etl/download-dados-rf.js [YYYY-MM]
   ============================================================ */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const periodo = process.argv[2] || process.env.RF_PERIODO || (await detectLatestPeriodo());
    if (!periodo) throw new Error('Nenhum período publicado encontrado');
    await downloadPeriodo(periodo);
    console.log('Próximo passo: npm run import');
  })().catch((err) => {
    console.error('Erro fatal:', err);
    process.exit(1);
  });
}
