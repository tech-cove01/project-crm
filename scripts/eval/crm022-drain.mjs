import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const origin = 'http://localhost:3415';
const path = '/api/v1/cron/ai-integration-drain';

async function main() {
  const limit = Number(process.argv[2]);
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 240, 'pass a limit from 1 to 240');
  assert.equal(process.env.NEXT_PUBLIC_APP_URL, origin);
  const url = new URL(process.env.SUPABASE_DB_URL);
  assert(url.hostname === '127.0.0.1' && url.port === '55522' && url.pathname === '/postgres');
  const pool = new pg.Pool({ connectionString: url.href, options: '-c default_transaction_read_only=on', max: 1 });
  try {
    const { rows } = await pool.query(`select id,slug from organizations`);
    assert(rows.length === 1 && rows[0].id === process.env.CRM022_ORG_ID && rows[0].slug === 'crm022-synthetic-eval');
  } finally { await pool.end(); }

  const token = process.env.INTERNAL_CRON_SECRET;
  assert(token && token.length >= 32);
  const file = `.local/crm022/delivery-ticks-${Date.now()}.jsonl`;
  let empty = 0;
  for (let index = 1; index <= limit; index++) {
    const start = Date.now();
    const r = await fetch(origin + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(70_000) });
    const data = (await r.json().catch(() => null))?.data;
    const receipt = { tick: index, at: new Date(start).toISOString(), elapsedMs: Date.now()-start, http: r.status,
      scanned: data?.scanned ?? null, done: data?.done ?? null, dead: data?.dead ?? null, projected: data?.projected ?? null };
    appendFileSync(file, JSON.stringify(receipt) + '\n', { mode: 0o600 });
    assert(r.ok && Number.isInteger(receipt.scanned), 'delivery_tick_failed');
    empty = receipt.scanned === 0 && receipt.projected === 0 ? empty + 1 : 0;
    if (empty >= 3) break;
    await sleep(500);
  }
  console.log(JSON.stringify({ result: file }));
}

main().catch(error => {
  console.error('crm022_integration_delivery_failed', error.code ?? error.name);
  process.exitCode = 1;
});
