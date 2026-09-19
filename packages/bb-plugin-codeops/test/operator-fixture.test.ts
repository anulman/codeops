// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, validationRequest, type Run } from '../core/model.ts';
const exec=promisify(execFile),script=fileURLToPath(new URL('../operator/native-fixture.ts',import.meta.url));
test('operator capture reads native dispatch events when ThreadResponse has no mode',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'codeops-native-fixture-'));
  try {
    const fixture={key:'qualification',projectId:'project',parentThreadId:'parent',environmentId:'env',repository:'https://github.com/example/repo',base:'a'.repeat(40),
      candidate:{head:'b'.repeat(40),tree:'c'.repeat(40),files:['file']},hostId:'host',expectedPermissionMode:'full'};
    const input=join(dir,'fixture.json'),command=join(dir,'start.json'),statePath=join(dir,'state.json');
    await writeFile(input,JSON.stringify(fixture));
    await exec(process.execPath,['--experimental-strip-types',script,'prepare',input,command]);
    const {brief}=JSON.parse(await readFile(command,'utf8'));
    // Deliberately simulated CLI records. These are unit fixtures, not live evidence.
    const run={id:'run',generation:1,lease:'lease',brief,scopeDigest:digest(brief),candidate:fixture.candidate,stage:'Publish',condition:'NeedsAttention',
      actions:[{kind:'worker',threadId:'worker',state:'succeeded'},{kind:'reviewer',threadId:'reviewer',state:'succeeded'}],checks:[]} as unknown as Run;
    run.checks=[{name:brief.checks[0].name,candidate:fixture.candidate.head,tree:fixture.candidate.tree,argvDigest:digest(brief.checks[0].argv),exitCode:0,outputDigest:digest('unit-fixture'),
      isolation:{backend:'kubernetes-job',version:1,requestDigest:digest(validationRequest(run,brief.checks[0])),namespace:'validation',jobName:'job',jobUid:'job-uid',podUid:'pod-uid',
        image:`registry.example/check@sha256:${'d'.repeat(64)}`,runId:run.id,generation:run.generation,lease:run.lease,repository:brief.repository,base:brief.base}}];
    run.review={candidate:fixture.candidate.head,tree:fixture.candidate.tree,scopeDigest:run.scopeDigest,evidenceDigest:digest(run.checks),outcome:'accept',findings:[],scopeAssessment:'Unit fixture'};
    await writeFile(statePath,JSON.stringify(run));
    await writeFile(join(dir,'bb'),`#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nif(args[1]==='log'&&process.env.FIXTURE_FAIL){console.log('raw-event-sentinel');console.error('raw-error-sentinel');process.exit(1); }\nif(args[0]==='codeops') console.log(fs.readFileSync(process.env.FIXTURE_STATE,'utf8'));\nelse if(args[0]==='thread'&&args[1]==='show') console.log(JSON.stringify({thread:{id:args[2],environmentId:'env',status:'idle',runtime:{displayStatus:'idle',hostReconnectGraceExpiresAt:null}},environment:{},pendingTodos:[]}));\nelse if(args[0]==='thread'&&args[1]==='log') console.log(JSON.stringify([\n {id:'request-event',threadId:args[2],seq:1,type:'client/turn/requested',scope:{kind:'thread'},data:{direction:'outbound',source:'spawn',requestId:'request',execution:{permissionMode:process.env.FIXTURE_MODE}}},\n {id:'accepted-event',threadId:args[2],seq:2,type:'turn/input/accepted',scope:{kind:'turn',turnId:'turn'},data:{clientRequestId:'request'}},\n {id:'completed-event',threadId:args[2],seq:3,type:'turn/completed',scope:{kind:'turn',turnId:'turn'},data:{status:'completed'}}\n]));\nelse if(args[0]==='environment') console.log(JSON.stringify({hostId:'host'}));\nelse process.exit(1);\n`,{mode:0o700});
    const env={...process.env,PATH:`${dir}:${process.env.PATH}`,FIXTURE_STATE:statePath,FIXTURE_MODE:'full'};
    const output=join(dir,'capture.json');
    await exec(process.execPath,['--experimental-strip-types',script,'capture',input,output,'run'],{env});
    const captured=JSON.parse(await readFile(output,'utf8'));
    assert.equal(captured.threads.length,2);assert.equal(captured.threads[1].execution[0].permissionMode,'full');
    await assert.rejects(exec(process.execPath,['--experimental-strip-types',script,'capture',input,join(dir,'wrong.json'),'run'],{env:{...env,FIXTURE_MODE:'accept-edits'}}),/Native execution policy mismatch/);
    await assert.rejects(exec(process.execPath,['--experimental-strip-types',script,'capture',input,join(dir,'failed.json'),'run'],{env:{...env,FIXTURE_FAIL:'1'}}),(error:any)=>{
      assert.match(error.stderr,/Native bb readback unavailable/);assert.equal(String(error.stderr).includes('sentinel'),false);assert.equal(String(error.stdout).includes('sentinel'),false);return true;
    });
  } finally {await rm(dir,{recursive:true,force:true});}
});
