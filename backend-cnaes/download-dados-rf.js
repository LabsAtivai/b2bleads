import fs from 'fs';
import path from 'path';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

/* ============================================================
   CONFIGURAÇÃO
   ============================================================ */

// Share público da Receita Federal (Nextcloud/SERPRO+)
const SHARE_TOKEN = 'gn672Ad4CF8N6TK';
const WEBDAV_BASE = `https://arquivos.receitafederal.gov.br/public.php/webdav`;
const CNPJ_DIR = 'Dados/Cadastros/CNPJ';

// Pasta de destino local
const DEST_DIR = path.resolve(process.env.LOCAL_ZIPS_DIR || './zips_cnpj');

// Periodo a baixar (mais recente disponivel com dados de 2025+)
const PERIODO = process.env.RF_PERIODO || '2026-06';

const FILES = [
  // Dominios (tabelas de referencia - ~poucos KB cada)
  'Cnaes.zip',
  'Motivos.zip',
  'Municipios.zip',
  'Naturezas.zip',
  'Paises.zip',
  'Qualificacoes.zip',

  // Simples/MEI
  'Simples.zip',

  // Empresas (10 partes)
  ...Array.from({ length: 10 }, (_, i) => `Empresas${i}.zip`),

  // Estabelecimentos (10 partes)
  ...Array.from({ length: 10 }, (_, i) => `Estabelecimentos${i}.zip`),

  // Socios (10 partes)
  ...Array.from({ length: 10 }, (_, i) => `Socios${i}.zip`),
];

/* ============================================================
   DOWNLOAD VIA WEBDAV (autenticação via share token)
   ============================================================ */

function downloadFile(fileName) {
  const remotePath = `${CNPJ_DIR}/${PERIODO}/${fileName}`;
  const url = `${WEBDAV_BASE}/${remotePath}`;
  const destPath = path.join(DEST_DIR, fileName);
  const tmpPath = destPath + '.tmp';

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
    const auth = Buffer.from(`${SHARE_TOKEN}:`).toString('base64');

    const doRequest = (requestUrl, redirectCount = 0) => {
      if (redirectCount > 10) {
        file.destroy();
        cleanup(tmpPath);
        return done(new Error('Muitos redirecionamentos'));
      }

      const urlObj = new URL(requestUrl);
      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: { 'Authorization': `Basic ${auth}` },
        timeout: 300000,
      };

      const req = https.request(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return doRequest(res.headers.location, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          file.destroy();
          cleanup(tmpPath);
          return done(new Error(`HTTP ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
        let downloaded = 0;
        let lastPrint = 0;

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          const now = Date.now();
          if (now - lastPrint > 2000) {
            lastPrint = now;
            const mb = (downloaded / 1048576).toFixed(1);
            if (totalBytes > 0) {
              const pct = ((downloaded / totalBytes) * 100).toFixed(1);
              const totalMb = (totalBytes / 1048576).toFixed(1);
              process.stdout.write(`  ${fileName}: ${mb}MB / ${totalMb}MB (${pct}%)   \r`);
            } else {
              process.stdout.write(`  ${fileName}: ${mb}MB   \r`);
            }
          }
        });

        res.on('error', (err) => {
          file.destroy();
          cleanup(tmpPath);
          done(err);
        });

        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            if (settled) return;
            try {
              fs.renameSync(tmpPath, destPath);
            } catch (renameErr) {
              return done(renameErr);
            }
            const finalMb = (downloaded / 1048576).toFixed(1);
            console.log(`  ${fileName}: OK (${finalMb}MB)                    `);
            done(null, downloaded);
          });
        });

        file.on('error', (err) => {
          cleanup(tmpPath);
          done(err);
        });
      });

      req.on('error', (err) => {
        file.destroy();
        cleanup(tmpPath);
        done(err);
      });

      req.on('timeout', () => {
        req.destroy();
        file.destroy();
        cleanup(tmpPath);
        done(new Error('Timeout (5min)'));
      });

      req.end();
    };

    doRequest(url);
  });
}

function cleanup(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

/* ============================================================
   MAIN
   ============================================================ */

async function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });

  console.log('=============================================');
  console.log('  Download Dados CNPJ - Receita Federal');
  console.log('=============================================');
  console.log(`Periodo:  ${PERIODO}`);
  console.log(`Destino:  ${DEST_DIR}`);
  console.log(`Arquivos: ${FILES.length}`);
  console.log('=============================================\n');

  let ok = 0;
  let skip = 0;
  let fail = 0;
  let totalBytes = 0;
  const errors = [];

  for (let i = 0; i < FILES.length; i++) {
    const fileName = FILES[i];
    const destPath = path.join(DEST_DIR, fileName);

    // Pula se ja existe com tamanho razoavel
    if (fs.existsSync(destPath)) {
      const stat = fs.statSync(destPath);
      if (stat.size > 10000) {
        console.log(`[${i + 1}/${FILES.length}] ${fileName}: ja existe (${(stat.size / 1048576).toFixed(1)}MB)`);
        skip++;
        totalBytes += stat.size;
        continue;
      }
    }

    console.log(`[${i + 1}/${FILES.length}] Baixando ${fileName}...`);

    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        const bytes = await downloadFile(fileName);
        totalBytes += bytes;
        ok++;
        break;
      } catch (err) {
        console.error(`  ERRO (tentativa ${tentativa}/3): ${err.message}`);
        if (tentativa === 3) {
          fail++;
          errors.push({ fileName, error: err.message });
        } else {
          const wait = tentativa * 10;
          console.log(`  Aguardando ${wait}s...`);
          await new Promise(r => setTimeout(r, wait * 1000));
        }
      }
    }
  }

  console.log(`\n=============================================`);
  console.log(`  ${ok} baixados | ${skip} ja existiam | ${fail} falhas`);
  console.log(`  Total: ${(totalBytes / 1073741824).toFixed(2)}GB`);
  console.log(`=============================================`);

  if (errors.length) {
    console.log('\nArquivos com falha (rode novamente para tentar):');
    errors.forEach(e => console.log(`  - ${e.fileName}: ${e.error}`));
  }

  console.log('\nProximo passo: npm run import');
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
