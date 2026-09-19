// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionPolicySchema, loadExecutionPolicy, permissionModeForHost } from '../execution-policy.ts';
const policy={version:1 as const,externalSandboxHosts:[{hostId:'isolated-host',profile:'kubernetes-isolated-worker-v1' as const}]};
test('only an exact attested host selects full; unsupported profiles and broad matches fail closed',()=>{
  assert.equal(permissionModeForHost('isolated-host',policy),'full');
  for(const host of ['other','isolated-host-copy','ISOLATED-HOST','']) assert.equal(permissionModeForHost(host,policy),'accept-edits');
  for(const change of [
    {externalSandboxHosts:[{hostId:'*',profile:'kubernetes-isolated-worker-v1'}]},
    {externalSandboxHosts:[{hostId:'isolated-host',profile:'shared-server'}]},
    {externalSandboxHosts:[...policy.externalSandboxHosts,...policy.externalSandboxHosts]},
    {permissionMode:'full'},
  ]) assert.equal(executionPolicySchema.safeParse({...policy,...change}).success,false);
});
test('protected file loader rejects writable, symlinked, missing and malformed configuration; rereads revocation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'codeops-policy-')),path=join(dir,'policy.json');
  try {
    await writeFile(path,JSON.stringify(policy),{mode:0o600});
    assert.equal(permissionModeForHost('isolated-host',await loadExecutionPolicy(path)),'full');
    await writeFile(path,JSON.stringify({version:1,externalSandboxHosts:[]}));
    assert.equal(permissionModeForHost('isolated-host',await loadExecutionPolicy(path)),'accept-edits');
    await chmod(path,0o666);await assert.rejects(loadExecutionPolicy(path),/protected/);
    await chmod(path,0o600);await writeFile(path,'{broken');await assert.rejects(loadExecutionPolicy(path));
    await symlink(path,join(dir,'link'));await assert.rejects(loadExecutionPolicy(join(dir,'link')));
    await assert.rejects(loadExecutionPolicy(join(dir,'missing')));
    await assert.rejects(loadExecutionPolicy('relative.json'));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('absent server configuration preserves the default',async()=>{
  const previous=process.env.CODEOPS_EXECUTION_CONFIG;
  try {delete process.env.CODEOPS_EXECUTION_CONFIG;assert.equal(permissionModeForHost('isolated-host',await loadExecutionPolicy()),'accept-edits');}
  finally {if(previous===undefined)delete process.env.CODEOPS_EXECUTION_CONFIG;else process.env.CODEOPS_EXECUTION_CONFIG=previous;}
});
