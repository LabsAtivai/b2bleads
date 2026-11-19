/* eslint-disable no-console */
// Aviso opcional por webhook (n8n, Slack, Discord, etc.). Sem ETL_WEBHOOK_URL, só loga.
export async function notify(event, payload = {}) {
  const url = process.env.ETL_WEBHOOK_URL;
  const body = { app: 'b2bleads-etl', event, at: new Date().toISOString(), ...payload };
  body.text = `[b2bleads-etl] ${event}${payload.periodo ? ` ${payload.periodo}` : ''}${payload.error ? `: ${payload.error}` : ''}`;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.warn(`Webhook respondeu HTTP ${res.status}`);
  } catch (err) {
    console.warn(`Falha ao enviar webhook: ${err.message}`);
  }
}
