import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { requireDisposablePostgres } from './disposable-postgres.mjs';
const url = process.env.CODEOPS_TEST_POSTGRES_URL;
await requireDisposablePostgres(url);
let proofs = 1;
for (const target of [
  'postgresql://postgres@127.0.0.1:5432/agents',
  'postgresql://postgres@10.0.0.1:5432/codeops_disposable_test',
  url + '?host=production',
]) {
  await assert.rejects(requireDisposablePostgres(target), /target refused/); proofs++;
}
const system = process.env.CODEOPS_DISPOSABLE_SYSTEM_ID;
process.env.CODEOPS_DISPOSABLE_SYSTEM_ID = '1';
await assert.rejects(requireDisposablePostgres(url), /identity mismatch/); proofs++;
process.env.CODEOPS_DISPOSABLE_SYSTEM_ID = system;
const run = process.env.CODEOPS_DISPOSABLE_RUN;
delete process.env.CODEOPS_DISPOSABLE_RUN;
await assert.rejects(requireDisposablePostgres(url), /launcher identity/); proofs++;
process.env.CODEOPS_DISPOSABLE_RUN = run;
for (const host of ['10.0.0.1', '169.254.169.254', '1.1.1.1']) {
  await new Promise((resolve, reject) => {
    const socket = connect({ host, port: 5432 });
    socket.setTimeout(500, () => { socket.destroy(); reject(new Error('Expected kernel refusal, not timeout')); });
    socket.on('connect', () => { socket.destroy(); reject(new Error('Unexpected network reachability')); });
    socket.on('error', error => {
      if (!['ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)) reject(error); else resolve();
    });
  }); proofs++;
}
for (const path of ['/var/run/docker.sock', '/var/run/secrets/kubernetes.io', '/root/.kube/config', '/root/.config/gh/hosts.yml']) {
  assert.equal(existsSync(path), false); proofs++;
}
assert.equal(Object.keys(process.env).some(key => /TOKEN|PASSWORD|SECRET|KUBECONFIG|DATABASE_URL_FILE/.test(key)), false); proofs++;
console.log(JSON.stringify({event:'harmless_refusal_proofs', passed:proofs, skipped:0}));
