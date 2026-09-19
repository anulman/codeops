// SPDX-License-Identifier: Apache-2.0
// Operator-side fixture for a temporary isolated bb installation. No deployment.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { briefSchema, candidateSchema, digest, evaluate, type Run } from '../core/model.ts';
import { readExecutionEvidence } from './execution-readback.ts';
const exec=promisify(execFile);
const schema=z.object({key:briefSchema.shape.key,projectId:briefSchema.shape.projectId,parentThreadId:briefSchema.shape.parentThreadId,
  environmentId:briefSchema.shape.environmentId,repository:briefSchema.shape.repository,base:briefSchema.shape.base,
  candidate:candidateSchema,hostId:z.string().min(1),expectedPermissionMode:z.enum(['accept-edits','full'])}).strict();
const [operation,inputPath,outputPath,runId]=process.argv.slice(2);
if(!['prepare','capture'].includes(operation??'')||!inputPath||!outputPath) throw new Error('Usage: native-fixture.ts prepare|capture <fixture.json> <new-output.json> [run-id]');
const fixture=schema.parse(JSON.parse(await readFile(inputPath,'utf8')));
const outcome=`Qualify candidate ${fixture.candidate.head} without source changes`;
const brief=briefSchema.parse({key:fixture.key,projectId:fixture.projectId,parentThreadId:fixture.parentThreadId,environmentId:fixture.environmentId,
  repository:fixture.repository,base:fixture.base,outcome,
  scope:[`Read-only qualification. Preserve exact clean HEAD ${fixture.candidate.head}. Do not create or amend commits. Run pwd, id, git status --short and git rev-parse HEAD; report observations. No publication, installation, deployment, credentials or infrastructure changes.`],
  acceptance:[`HEAD and tree remain ${fixture.candidate.head} and ${fixture.candidate.tree}.`,
    'The native worker completes harmless shell checks. The trusted validator supplies exact Job evidence. Independent review confirms no source changes and no unsupported completion claims.'],
  checks:[{name:'execution-policy',argv:['node','--experimental-strip-types','--test','packages/bb-plugin-codeops/test/execution-policy.test.ts']}],
  correctionLimit:0,intent:{provider:'local',item:fixture.key,revision:fixture.candidate.head}});
async function bb(args:string[]) {
  try {return JSON.parse((await exec('bb',args,{timeout:30000,maxBuffer:1024*1024})).stdout);}
  catch {throw new Error('Native bb readback unavailable or over limit; no evidence accepted');}
}
if(operation==='prepare') await writeFile(outputPath,JSON.stringify({op:'start',brief},null,2)+'\n',{flag:'wx',mode:0o600});
else {
  if(!runId) throw new Error('Run ID required');
  const run=await bb(['codeops','command',JSON.stringify({op:'get',id:runId})]) as Run;
  if(digest(run.brief)!==digest(brief)||digest(run.candidate)!==digest(fixture.candidate)||run.stage!=='Publish'||run.condition!=='NeedsAttention'||
    evaluate(run,'G3').outcome!=='allow'||evaluate(run,'G4').outcome!=='allow') throw new Error('Native fixture has not reached exact validated/reviewed manual handoff');
  const children=run.actions.filter(a=>a.kind==='worker'||a.kind==='reviewer');
  if(children.length!==2||children.some(a=>!a.threadId||a.state!=='succeeded')||new Set(children.map(a=>a.threadId)).size!==2) throw new Error('Expected distinct native worker and reviewer');
  const threads=[];
  for(const child of children) {
    const {thread}=await bb(['thread','show',child.threadId!,'--json']);
    if(!thread||thread.id!==child.threadId||thread.status!=='idle') throw new Error('Native child identity/status mismatch');
    const execution=await readExecutionEvidence(thread.id,fixture.expectedPermissionMode,afterSeq=>bb([
      'thread','log',thread.id,'--json','--limit','100',...(afterSeq===undefined?[]:['--after-seq',String(afterSeq)]),
    ]));
    const environment=await bb(['environment','show',thread.environmentId,'--json']);
    if(environment.hostId!==fixture.hostId) throw new Error('Native child host drift');
    threads.push({id:thread.id,execution,environmentId:thread.environmentId,hostId:environment.hostId,status:thread.status});
  }
  if(run.checks.some(c=>c.isolation.backend!=='kubernetes-job')) throw new Error('Actual Kubernetes evidence required');
  await writeFile(outputPath,JSON.stringify({candidate:fixture.candidate,run,threads},null,2)+'\n',{flag:'wx',mode:0o600});
}
