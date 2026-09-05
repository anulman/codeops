import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';
import { requireDisposablePostgres } from '../../../infra/scripts/disposable-postgres.mjs';
import { migrateSessionBroker, grantApplicationDatabaseAccess, requireApplicationDatabaseAuthority, grantSessionRuntimeReceiptAccess, grantLifecycleRelayAccess, grantModelProxyLedgerAccess } from '../dist/session-broker-migration.js';
const url = process.env.CODEOPS_TEST_POSTGRES_URL;
if (url !== undefined) await requireDisposablePostgres(url);
test('database roles refuse schema destruction and supervisor writes', {skip: !url}, async () => {
  const owner = new Client({connectionString:url}); await owner.connect();
  try {
    await owner.query("SELECT pg_advisory_lock(hashtext('codeops-control-gateway-postgres-tests'))");
    await owner.query('DROP SCHEMA IF EXISTS codeops CASCADE');
    await migrateSessionBroker(owner);
    // Disposable loopback trust authentication; generated value never leaves memory.
    const { randomBytes } = await import('node:crypto');
    await grantApplicationDatabaseAccess(owner, 'codeops_app', randomBytes(32).toString('hex'));
    await assert.rejects(requireApplicationDatabaseAuthority(owner), /ownership or administration/);
    await grantSessionRuntimeReceiptAccess(owner, 'codeops_runtime_receipts', randomBytes(32).toString('hex'));
    await grantLifecycleRelayAccess(owner, 'codeops_lifecycle_relay', randomBytes(32).toString('hex'));
    await grantModelProxyLedgerAccess(owner, 'codeops_model_proxy', randomBytes(32).toString('hex'));
    await owner.query('CREATE ROLE codeops_inspection_login LOGIN IN ROLE codeops_inspector');
    const identities = [
      ['codeops_app', 'SELECT count(*) FROM codeops.sessions'],
      ['codeops_inspection_login', 'SELECT count(*) FROM codeops.sessions'],
      ['codeops_runtime_receipts', 'SELECT dispatch_id FROM codeops.session_runtime_execution_receipts LIMIT 0'],
      ['codeops_lifecycle_relay', 'SELECT event_id FROM codeops.work_item_lifecycle_events LIMIT 0'],
      ['codeops_model_proxy', "SELECT has_function_privilege(current_user, 'codeops.charge_stale_session_model_budget_reservations()', 'EXECUTE')"],
    ];
    for (const [role, read] of identities) {
      const target = new URL(url); target.username = role;
      const connection = new Client({connectionString: target.toString()});
      await connection.connect();
      try {
        await connection.query(read);
        if (role === 'codeops_app') {
          await requireApplicationDatabaseAuthority(connection);
          await connection.query('DELETE FROM codeops.sessions WHERE false');
        }
        for (const statement of [
          'DROP SCHEMA codeops CASCADE', 'DROP TABLE codeops.sessions',
          'CREATE TABLE codeops.unexpected(id int)', 'ALTER ROLE codeops_app SUPERUSER',
          'SET ROLE postgres',
          ...(role === 'codeops_inspection_login' ? ['DELETE FROM codeops.sessions', 'INSERT INTO codeops.sessions DEFAULT VALUES'] : []),
        ]) {
          await connection.query('BEGIN');
          await assert.rejects(connection.query(statement), error => error.code === '42501', statement);
          await connection.query('ROLLBACK');
        }
      } finally { await connection.end(); }
    }
    await owner.query('GRANT postgres TO codeops_app');
    await assert.rejects(grantApplicationDatabaseAccess(owner, 'codeops_app', randomBytes(32).toString('hex')), /no ownership or memberships/);
    await owner.query('REVOKE postgres FROM codeops_app');
    await owner.query('CREATE TABLE codeops.deployment_only(id int)');
    await owner.query('DROP TABLE codeops.deployment_only');
    assert.equal((await owner.query("SELECT to_regclass('codeops.sessions') AS relation")).rows[0].relation, 'codeops.sessions');
  } finally { await owner.end(); }
});
