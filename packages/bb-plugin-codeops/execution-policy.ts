// SPDX-License-Identifier: Apache-2.0
// Trusted server configuration only; never load from a workspace or host RPC.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
export const executionPolicySchema=z.object({
  version:z.literal(1),
  externalSandboxHosts:z.array(z.object({
    hostId:z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    // Operator attests the outer Pod, storage, credentials and network boundary.
    profile:z.literal('kubernetes-isolated-worker-v1'),
  }).strict()).max(1000),
}).strict().refine(policy=>new Set(policy.externalSandboxHosts.map(h=>h.hostId)).size===policy.externalSandboxHosts.length,'Duplicate host attestation');
export type ExecutionPolicy=z.infer<typeof executionPolicySchema>;
export async function loadExecutionPolicy(path:string|undefined=process.env.CODEOPS_EXECUTION_CONFIG):Promise<ExecutionPolicy> {
  if(path===undefined) return {version:1,externalSandboxHosts:[]};
  if(!isAbsolute(path)) throw new Error('Execution policy must use a protected absolute server path');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>256*1024||(stat.mode&0o022)!==0||
      (stat.uid!==0&&stat.uid!==process.getuid?.())) throw new Error('Execution policy is not a protected server file');
    return executionPolicySchema.parse(JSON.parse(await file.readFile('utf8')));
  } finally {await file.close();}
}
export function permissionModeForHost(hostId:string,policy:ExecutionPolicy):'accept-edits'|'full' {
  return executionPolicySchema.parse(policy).externalSandboxHosts.some(host=>host.hostId===hostId)?'full':'accept-edits';
}
