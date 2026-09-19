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
test('operator capture understands CLI envelopes and rejects substituted native modes',async()=>{
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
    await writeFile(join(dir,'bb'),`#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nif(args[0]==='codeops') console.log(fs.readFileSync(process.env.FIXTURE_STATE,'utf8'));\nelse if(args[0]==='thread') console.log(JSON.stringify({thread:{id:args[2],environmentId:'env',permissionMode:process.env.FIXTURE_MODE,status:'idle'},environment:{},pendingTodos:[]}));\nelse if(args[0]==='environment') console.log(JSON.stringify({hostId:'host'}));\nelse process.exit(1);\n`,{mode:0o700});
    const env={...process.env,PATH:`${dir}:${process.env.PATH}`,FIXTURE_STATE:statePath,FIXTURE_MODE:'full'};
    const output=join(dir,'capture.json');
    await exec(process.execPath,['--experimental-strip-types',script,'capture',input,output,'run'],{env});
    const captured=JSON.parse(await readFile(output,'utf8'));
    assert.equal(captured.threads.length,2);assert.equal(captured.threads[1].permissionMode,'full');
    await assert.rejects(exec(process.execPath,['--experimental-strip-types',script,'capture',input,join(dir,'wrong.json'),'run'],{env:{...env,FIXTURE_MODE:'accept-edits'}}),/mode\/status mismatch/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
