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
    // Existing login/admin flags must be normalized, not retained. Use a
    // real direct connection before and after provisioning (loopback trust).
    await owner.query('ALTER ROLE codeops_inspector LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS');
    const inspectorUrl = new URL(url); inspectorUrl.username = 'codeops_inspector';
    const previousInspector = new Client({connectionString: inspectorUrl.toString()});
    await previousInspector.connect();
    await previousInspector.end();
    await grantApplicationDatabaseAccess(owner, 'codeops_app', randomBytes(32).toString('hex'));
    const flags = (await owner.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
      rolreplication, rolbypassrls FROM pg_roles WHERE rolname='codeops_inspector'`)).rows[0];
    assert.deepEqual(flags, {rolcanlogin:false, rolsuper:false, rolcreatedb:false,
      rolcreaterole:false, rolreplication:false, rolbypassrls:false});
    const refusedInspector = new Client({connectionString: inspectorUrl.toString()});
    try { await assert.rejects(refusedInspector.connect(), error => error.code === '28000'); }
    finally { await refusedInspector.end(); }
    // Membership is refused transactionally, including a NOINHERIT parent.
    await owner.query('CREATE ROLE inspector_parent NOLOGIN');
    await owner.query('ALTER ROLE codeops_inspector LOGIN NOINHERIT');
    await owner.query('GRANT inspector_parent TO codeops_inspector');
    await assert.rejects(grantApplicationDatabaseAccess(owner, 'codeops_app', randomBytes(32).toString('hex')), /no ownership or memberships/);
    assert.equal((await owner.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='codeops_inspector'")).rows[0].rolcanlogin, true);
    await owner.query('REVOKE inspector_parent FROM codeops_inspector');
    await owner.query('DROP ROLE inspector_parent');
    await grantApplicationDatabaseAccess(owner, 'codeops_app', randomBytes(32).toString('hex'));
    await owner.query('CREATE ROLE codeops_inspection_login LOGIN IN ROLE codeops_inspector');
    // Existing member logins are permitted: the group itself remains NOLOGIN.
    await grantApplicationDatabaseAccess(owner, 'codeops_app', randomBytes(32).toString('hex'));

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
        assert.equal((await connection.query('SELECT current_user AS identity')).rows[0].identity, role);
        if (role === 'codeops_inspection_login') {
          // Do not rely on default_transaction_read_only; ACLs must refuse writes.
          await connection.query('SET default_transaction_read_only = off');
          const acl = (await connection.query(`SELECT
            has_table_privilege(current_user, 'codeops.sessions', 'SELECT') AS read,
            has_table_privilege(current_user, 'codeops.sessions', 'INSERT,UPDATE,DELETE,TRUNCATE') AS write,
            has_schema_privilege(current_user, 'codeops', 'CREATE') AS create`)).rows[0];
          assert.deepEqual(acl, {read:true, write:false, create:false});
        }
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
