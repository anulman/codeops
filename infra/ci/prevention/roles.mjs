// Real independent connections; no mock grants or successful-denial substitutes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { Client } = createRequire(process.cwd() + '/services/codeops-control-gateway/package.json')('pg');
const read = path => fs.readFileSync(path, 'utf8').trim();
const identities = [
  ['/db/database-url', 'codeops_app', 'SELECT migration_name FROM codeops.schema_migrations'],
  ['/db/runtime-database-url', 'codeops_runtime_receipts', 'SELECT dispatch_id FROM codeops.session_runtime_execution_receipts'],
  ['/proxy/database-url', 'codeops_model_proxy', 'SELECT codeops.charge_stale_session_model_budget_reservations()'],
  ['/relay/database-url', 'codeops_lifecycle_relay', 'SELECT event_id FROM codeops.work_item_lifecycle_events'],
  ['/inspector/database-url', 'fixture_inspector', 'SELECT migration_name FROM codeops.schema_migrations'],
];
for (const [path, role, positive] of identities) {
  const c = new Client({ connectionString: read(path), connectionTimeoutMillis: 3000 });
  await c.connect();
  try {
    assert.equal((await c.query('SELECT current_user AS role')).rows[0].role, role);
    await c.query(positive);
    for (const denied of ['DROP SCHEMA codeops CASCADE', 'CREATE SCHEMA escaped',
      'ALTER ROLE agents SUPERUSER', 'SET ROLE agents', 'CREATE TABLE codeops.escaped(id int)']) {
      await c.query('BEGIN');
      try {
        await assert.rejects(c.query(denied), e => e.code === '42501' || e.code === '25006');
      } finally { await c.query('ROLLBACK'); }
    }
    if (role === 'codeops_app') {
      await c.query('BEGIN');
      await c.query('INSERT INTO codeops.fixture_writes VALUES(9,9)');
      await c.query('UPDATE codeops.fixture_writes SET value=10 WHERE id=9');
      await c.query('DELETE FROM codeops.fixture_writes WHERE id=9');
      await c.query('ROLLBACK');
      await assert.rejects(c.query("DELETE FROM codeops.schema_migrations"), e => e.code === '42501');
    } else if (role === 'fixture_inspector') {
      await assert.rejects(c.query('DELETE FROM codeops.fixture_writes'), e => ['42501', '25006'].includes(e.code));
    }
  } finally { await c.end(); }
}
console.log(JSON.stringify({ independentConnections: identities.length, ddlAndEscalation: 'refused', positiveControls: true }));
