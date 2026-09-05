import { networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
const { Client } = createRequire(new URL('../../services/codeops-control-gateway/package.json', import.meta.url))('pg');

// Defense in depth. The operator launcher, not repository code or these markers,
// owns credential, mount, image, process and network isolation.
export async function requireDisposablePostgres(connectionString) {
  const run = process.env.CODEOPS_DISPOSABLE_RUN;
  const system = process.env.CODEOPS_DISPOSABLE_SYSTEM_ID;
  if (!/^[0-9a-f-]{36}$/.test(run ?? '') || !/^[0-9]+$/.test(system ?? '')) {
    throw new Error('Disposable PostgreSQL launcher identity is required');
  }
  const url = new URL(connectionString);
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' ||
      url.port !== '5432' || url.pathname !== '/codeops_disposable_test' ||
      url.search || url.hash || url.password || url.username !== 'postgres') {
    throw new Error('Disposable PostgreSQL target refused');
  }
  if (Object.values(networkInterfaces()).flat().some(address => address && !address.internal)) {
    throw new Error('Disposable PostgreSQL requires a loopback-only network namespace');
  }
  const client = new Client({ connectionString, connectionTimeoutMillis: 1000 });
  try {
    await client.connect();
    const result = await client.query(`SELECT current_database() AS database,
      current_setting('codeops.disposable_run', true) AS run,
      (SELECT system_identifier::text FROM pg_control_system()) AS system`);
    const actual = result.rows[0];
    if (actual.database !== 'codeops_disposable_test' || actual.run !== run || actual.system !== system) {
      throw new Error('Disposable PostgreSQL server identity mismatch');
    }
  } finally { await client.end(); }
}
