/* eslint-disable no-console */
import dotenv from 'dotenv';
import { runEtl } from './pipeline.js';

dotenv.config();

// Janela mensal: tenta todo dia entre ETL_DAY_START e ETL_DAY_END, a partir de ETL_HOUR.
// Cada tentativa é barata quando não há período novo (sonda HEAD + consulta em etl_runs);
// o pipeline é idempotente e protegido por lock, então tentar de novo é seguro.
const DAY_START = Number(process.env.ETL_DAY_START || 5);
const DAY_END = Number(process.env.ETL_DAY_END || 20);
const HOUR = Number(process.env.ETL_HOUR || 3);
const CHECK_EVERY_MS = 30 * 60 * 1000;

let running = false;
let lastAttemptDay = '';

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

async function tick(force = false) {
  if (running) return;
  const now = new Date();
  const inWindow = now.getDate() >= DAY_START && now.getDate() <= DAY_END && now.getHours() >= HOUR;
  if (!force && (!inWindow || lastAttemptDay === dayKey(now))) return;

  running = true;
  lastAttemptDay = dayKey(now);
  try {
    const r = await runEtl();
    console.log(`[${new Date().toISOString()}] ETL: ${JSON.stringify(r)}`);
    // Período concluído ou já atualizado: não tenta de novo até a próxima janela.
    // Falha: libera nova tentativa no dia seguinte (lastAttemptDay já marcado).
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ETL erro:`, err.message);
  } finally {
    running = false;
  }
}

console.log(`ETL runner ativo. Janela: dias ${DAY_START}-${DAY_END}, a partir de ${HOUR}h (TZ=${process.env.TZ || 'padrão'})`);
if (process.env.RUN_ON_START === '1') tick(true);
setInterval(() => tick(), CHECK_EVERY_MS);
tick();
