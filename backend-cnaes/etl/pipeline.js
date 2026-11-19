/* eslint-disable no-console */
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDbName } from '../src/mongoConfig.js';
import { detectLatestPeriodo, downloadPeriodo } from './download-dados-rf.js';
import {
  newMongoClient, runImport, aggregateEmpresas, purgeStale, cleanupFiles, ensureIndexes,
} from './import.js';

const DB_NAME = getDbName();
const LOCK_TTL_MS = 10 * 60 * 1000;
const LOCK_RENEW_MS = 2 * 60 * 1000;
// Só purga dados antigos se a carga cobriu pelo menos isso (proteção contra carga parcial).
const MIN_EMPRESAS = Number(process.env.ETL_MIN_EMPRESAS || 40_000_000);
const MIN_RATIO_PREV = Number(process.env.ETL_MIN_RATIO_PREV || 0.95);

// Proteção do disco do servidor (compartilhado com dezenas de serviços).
const MIN_FREE_GB_START = Number(process.env.ETL_MIN_FREE_GB_START || 60);
const MIN_FREE_GB_ABORT = Number(process.env.ETL_MIN_FREE_GB_ABORT || 20);

async function freeDiskGb(db) {
  const st = await db.command({ dbStats: 1, scale: 1 });
  if (!st.fsTotalSize) return Infinity;
  return (st.fsTotalSize - st.fsUsedSize) / 1e9;
}

async function assertDisk(db, minGb, stage) {
  const free = await freeDiskGb(db);
  if (free < minGb) {
    throw new Error(`Disco insuficiente (${stage}): ${free.toFixed(1)} GB livres < mínimo ${minGb} GB`);
  }
  return free;
}

const OWNER = `${os.hostname()}:${process.pid}`;

async function acquireLock(db) {
  const col = db.collection('etl_lock');
  const now = new Date();
  try {
    await col.findOneAndUpdate(
      { _id: 'etl', $or: [{ expiresAt: { $lt: now } }, { owner: OWNER }] },
      { $set: { owner: OWNER, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // lock de outro processo ainda válido
    throw err;
  }
}

async function renewLock(db) {
  await db.collection('etl_lock').updateOne(
    { _id: 'etl', owner: OWNER },
    { $set: { expiresAt: new Date(Date.now() + LOCK_TTL_MS) } }
  );
}

async function releaseLock(db) {
  await db.collection('etl_lock').deleteOne({ _id: 'etl', owner: OWNER }).catch(() => { });
}

/**
 * Executa um ciclo completo: detecta período novo → baixa → importa → agrega → purga → limpa.
 * Idempotente: se o período já foi concluído, não faz nada. Se uma execução anterior
 * falhou depois da importação bruta, retoma a agregação do checkpoint.
 */
export async function runEtl({ periodo: periodoOverride, force = false } = {}) {
  const client = newMongoClient();
  await client.connect();
  const db = client.db(DB_NAME);
  const runs = db.collection('etl_runs');

  let heartbeat;
  let locked = false;
  try {
    locked = await acquireLock(db);
    if (!locked) {
      console.log('Outra execução do ETL está ativa (lock). Saindo.');
      return { status: 'locked' };
    }
    heartbeat = setInterval(() => renewLock(db).catch((e) => console.error('Falha ao renovar lock:', e.message)), LOCK_RENEW_MS);

    const periodo = periodoOverride || (await detectLatestPeriodo());
    if (!periodo) {
      console.log('Nenhum período publicado pela Receita. Saindo.');
      return { status: 'no-period' };
    }

    const existing = await runs.findOne({ _id: periodo });
    if (existing?.status === 'done' && !force) {
      console.log(`Período ${periodo} já concluído em ${existing.finishedAt?.toISOString?.()}. Nada a fazer.`);
      return { status: 'up-to-date', periodo };
    }

    const prevDone = await runs.find({ status: 'done', _id: { $ne: periodo } })
      .sort({ finishedAt: -1 }).limit(1).next();

    const resume = existing && existing.status !== 'done' && existing.rawDone && !force;
    const startedAt = new Date();
    await runs.updateOne(
      { _id: periodo },
      {
        $set: {
          periodo, status: 'running', stage: resume ? 'agg' : 'download', startedAt, error: null,
          host: OWNER, finishedAt: null,
        },
        $inc: { attempts: 1 },
        $setOnInsert: { createdAt: startedAt },
      },
      { upsert: true }
    );
    const setRun = (fields) => runs.updateOne({ _id: periodo }, { $set: fields });

    console.log(`=== ETL período ${periodo}${resume ? ' (retomando agregação)' : ''} ===`);

    try {
      let importStats = existing?.counts || {};

      if (!resume) {
        console.log(`Disco livre: ${(await assertDisk(db, MIN_FREE_GB_START, 'início')).toFixed(1)} GB`);
        await ensureIndexes(client);
        await downloadPeriodo(periodo);
        await setRun({ stage: 'import' });
        importStats = await runImport(client, { periodo });
        await setRun({ rawDone: true, stage: 'agg', counts: importStats, aggCheckpoint: '' });
      }

      const resumeFrom = resume ? (existing.aggCheckpoint || '') : '';
      const agg = await aggregateEmpresas(client, {
        periodo,
        resumeFrom,
        onCheckpoint: async (last, processed) => {
          await setRun({ aggCheckpoint: last, aggProcessed: (resume ? existing.aggProcessed || 0 : 0) + processed });
          if (processed % 20000 < 500) await assertDisk(db, MIN_FREE_GB_ABORT, 'agregação');
        },
      });
      const totalProcessed = (resume ? existing.aggProcessed || 0 : 0) + agg.processed;

      // Validação antes de qualquer remoção de dados.
      await setRun({ stage: 'purge' });
      const minPrev = prevDone?.aggProcessed ? Math.floor(prevDone.aggProcessed * MIN_RATIO_PREV) : 0;
      const minimo = Math.max(MIN_EMPRESAS, minPrev);
      let purge = null;
      let purgeSkipped = null;
      if (totalProcessed >= minimo) {
        purge = await purgeStale(client, periodo);
      } else {
        purgeSkipped = `processadas ${totalProcessed} < mínimo ${minimo}`;
        console.warn(`Purga pulada: ${purgeSkipped}`);
      }

      // Período concluído: remove CSVs e ZIPs (de todos os períodos) para liberar disco.
      await cleanupFiles([]).catch((e) => console.warn('Limpeza de arquivos falhou:', e.message));

      await setRun({
        status: 'done', stage: 'done', finishedAt: new Date(), aggProcessed: totalProcessed,
        truncados: agg.truncados, purge, purgeSkipped, counts: importStats,
      });
      console.log(`=== ETL período ${periodo} concluído: ${totalProcessed.toLocaleString()} empresas ===`);
      return { status: 'done', periodo, processed: totalProcessed, purgeSkipped };
    } catch (err) {
      console.error('ETL falhou:', err);
      await setRun({ status: 'failed', finishedAt: new Date(), error: String(err.stack || err.message || err).slice(0, 4000) });
      throw err;
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (locked) await releaseLock(db);
    await client.close().catch(() => { });
  }
}

/* CLI: node etl/pipeline.js [YYYY-MM] [--force] */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const periodo = args.find((a) => /^\d{4}-\d{2}$/.test(a));
  runEtl({ periodo, force })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch(() => process.exit(1));
}
