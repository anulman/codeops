// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Store } from '../core/store.ts';
import { Engine, type Runtime } from '../core/engine.ts';
import { digest, evaluate, validationRequest, jevUnavailable, type Brief, type Candidate, type Run } from '../core/model.ts';
const brief:Brief={key:'one',projectId:'project',parentThreadId:'parent',environmentId:'env',repository:'https://github.com/example/repository',base:'a'.repeat(40),outcome:'Correct a parser',scope:['Parser only'],acceptance:['Reject malformed input'],checks:[{name:'unit',argv:['node','--test']}],correctionLimit:1,intent:{provider:'local',item:'task-1',revision:'1'}};
const candidate:Candidate={head:'b'.repeat(40),tree:'c'.repeat(40),files:['parser.ts']};
function fixture(overrides:Partial<Runtime>={}) {
  const db=new Database(':memory:');const store=new Store(db);const spawned:string[]=[];let current:Run;
  const runtime:Runtime={
    async admit(){},async inspect(){return candidate;},async spawn(run,action){current=run;spawned.push(action.kind);return `thread-${spawned.length}`;},async find(){return ['thread-1'];},async status(){return 'idle';},
    async output(){return JSON.stringify({candidate:candidate.head,tree:candidate.tree,scopeDigest:current.scopeDigest,evidenceDigest:digest(current.checks),outcome:'accept',findings:[],scopeAssessment:'Necessary and proportionate'});},
    async stop(){},async attention(){},async checks(run){return brief.checks.map(c=>({name:c.name,candidate:run.candidate!.head,tree:run.candidate!.tree,argvDigest:digest(c.argv),exitCode:0,outputDigest:digest('ok'),isolation:{backend:'bubblewrap',version:1}}));},...overrides,
  };
  return {db,store,runtime,spawned,engine:new Engine(store,runtime)};
}
test('vertical flow binds real adapter evidence and stops at manual publication',async()=>{
  const f=fixture();let run=await f.engine.start(brief);assert.equal(run.stage,'Implement');
  run=await f.engine.advance(run.id);assert.equal(run.stage,'Critic');
  run=await f.engine.advance(run.id);assert.equal(run.stage,'Publish');assert.equal(run.condition,'NeedsAttention');
  assert.deepEqual(f.spawned,['worker','reviewer']);assert.equal(run.decisions.find(d=>d.gate==='G3')?.outcome,'allow');
  for(const gate of ['G5','G6','G7','G8'] as const) assert.equal(evaluate(run,gate).outcome,'needs_attention');f.db.close();
});
test('concurrent duplicate intake creates one durable run and child',async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.engine.start(brief),f.engine.start(brief)]);assert.equal(a.id,b.id);assert.equal(f.spawned.length,1);
  await assert.rejects(f.engine.start({...brief,outcome:'Wider scope'}),/Duplicate/);f.db.close();
});
test('unknown spawn is read back after restart, never repeated',async()=>{
  let spawns=0;const f=fixture({async spawn(){spawns++;throw new Error('connection lost after spawn');}});let run=await f.engine.start(brief);
  assert.equal(run.actions[0]!.state,'unknown');const restarted=new Engine(f.store,{...f.runtime,async status(){return 'running';}});
  run=await restarted.advance(run.id);assert.equal(run.actions[0]!.threadId,'thread-1');assert.equal(spawns,1);f.db.close();
});
test('absent and duplicate correlations block rather than retry',async()=>{
  for(const matches of [[],['one','two']]) {const f=fixture({async spawn(){throw new Error('unknown');},async find(){return matches;}});let run=await f.engine.start(brief);run=await f.engine.advance(run.id);assert.equal(run.condition,'NeedsAttention');assert.equal(run.actions.length,1);f.db.close();}
});
test('turn completion is not passing tests',async()=>{
  const f=fixture({async checks(){throw new Error('isolation unavailable');}});let run=await f.engine.start(brief);run=await f.engine.advance(run.id);assert.equal(run.stage,'Validate');assert.equal(run.condition,'NeedsAttention');assert.deepEqual(run.checks,[]);assert.deepEqual(f.spawned,['worker']);f.db.close();
});
test('changed head invalidates both review and tests',async()=>{
  const f=fixture();let run=await f.engine.start(brief);run=await f.engine.advance(run.id);
  f.runtime.inspect=async()=>({...candidate,head:'d'.repeat(40)});run=await f.engine.advance(run.id);assert.equal(run.stage,'Implement');assert.equal(run.candidate,null);assert.deepEqual(run.checks,[]);assert.equal(run.review,null);f.db.close();
});
test('candidate, scope, tree and evidence mismatch cannot qualify',async()=>{
  for(const field of ['candidate','tree','scopeDigest','evidenceDigest']) {
    const f=fixture();let run=await f.engine.start(brief);run=await f.engine.advance(run.id);
    const original=f.runtime.output;f.runtime.output=async id=>JSON.stringify({...JSON.parse(await original(id)),[field]:'f'.repeat(40)});
    run=await f.engine.advance(run.id);assert.equal(run.stage,'Critic');assert.equal(run.condition,'NeedsAttention');f.db.close();
  }
});
test('corrections stop at the frozen budget',async()=>{
  const f=fixture();const original=f.runtime.output;
  f.runtime.output=async id=>JSON.stringify({...JSON.parse(await original(id)),outcome:'rework',findings:[{requirement:'Reject malformed input',impact:'Accepts broken token',remedy:'Reject it'}]});
  let run=await f.engine.start(brief);for(let i=0;i<4;i++) run=await f.engine.advance(run.id);
  assert.equal(run.corrections,1);assert.equal(run.condition,'NeedsAttention');assert.deepEqual(f.spawned,['worker','reviewer','worker','reviewer']);f.db.close();
});
test('stop failure and stale commands never report cancellation success',async()=>{
  const f=fixture({async stop(){throw new Error('timeout');}});let run=await f.engine.start(brief);
  await assert.rejects(f.engine.pause(run.id,run.revision-1,true),/Stale/);run=await f.engine.pause(run.id,run.revision,true);assert.equal(run.condition,'NeedsAttention');assert.match(run.reason,/Stop failed/);f.db.close();
});
test('authority revocation stops advancement; Jev outage is typed',async()=>{
  const f=fixture();let run=await f.engine.start(brief);f.runtime.admit=async()=>{throw new Error('revoked');};run=await f.engine.advance(run.id);assert.equal(run.condition,'NeedsAttention');assert.equal(f.spawned.length,1);
  assert.equal((await jevUnavailable.assess({brief,selectedFacts:[]})).status,'unavailable');f.db.close();
});

test('cancellation intent survives failed stop and engine restart',async()=>{
  const f=fixture({async stop(){throw new Error('lost');}});let run=await f.engine.start(brief);run=await f.engine.pause(run.id,run.revision,true);
  await assert.rejects(f.engine.resume(run.id,run.revision),/Cancellation/);
  f.runtime.stop=async()=>{};run=await new Engine(f.store,f.runtime).advance(run.id);assert.equal(run.condition,'Cancelled');assert.equal(f.spawned.length,1);f.db.close();
});

test('different keys cannot share an unfinished implementation environment',async()=>{
  const f=fixture();const run=await f.engine.start(brief);
  await assert.rejects(f.engine.start({...brief,key:'two'}),/UNIQUE/);assert.equal(f.spawned.length,1);
  const cancelled=await f.engine.pause(run.id,run.revision,true);assert.equal(cancelled.condition,'Cancelled');
  await f.engine.start({...brief,key:'two'});assert.equal(f.spawned.length,2);f.db.close();
});
test('uncertain checks cannot rerun or release their environment through cancellation',async()=>{
  let checks=0;const f=fixture({async checks(){checks++;throw new Error('transport lost');}});let run=await f.engine.start(brief);run=await f.engine.advance(run.id);
  run=await new Engine(f.store,f.runtime).advance(run.id);assert.equal(checks,1);assert.equal(run.actions.at(-1)!.state,'unknown');
  run=await f.engine.pause(run.id,run.revision,true);assert.notEqual(run.condition,'Cancelled');await assert.rejects(f.engine.start({...brief,key:'two'}),/UNIQUE/);f.db.close();
});
test('reconciliation pages unfinished work beyond the UI window',async()=>{
  const f=fixture();const first=await f.engine.start(brief);
  for(let i=0;i<105;i++) await f.engine.start({...brief,key:`key-${i}`,environmentId:`env-${i}`});
  assert.ok(!f.store.list().some(r=>r.id===first.id));
  let cursor=0;const ids:string[]=[];
  for(;;){const page=f.store.pending(cursor);if(!page.runs.length)break;cursor=page.cursor;ids.push(...page.runs.map(r=>r.id));}
  assert.equal(ids.length,106);assert.ok(ids.includes(first.id));f.db.close();
});
test('resume replaces confirmed-stopped interrupted work before candidate inspection',async()=>{
  let active=true;let inspections=0;
  const f=fixture({async status(){return active?'running':'idle';},async stop(){active=false;},async inspect(){inspections++;return candidate;}});
  let run=await f.engine.start(brief);run=await f.engine.pause(run.id,run.revision);assert.equal(run.interrupted,'worker');
  run=await new Engine(f.store,f.runtime).resume(run.id,run.revision);assert.deepEqual(f.spawned,['worker','worker']);assert.equal(inspections,0);assert.equal(run.generation,2);f.db.close();
});

test('persisted scope and authority drift fail closed before any new effect',async()=>{
  const f=fixture();let run=await f.engine.start(brief);run.authority.effects.push('publish' as 'review');f.store.save(run,run.revision);
  run=await f.engine.advance(run.id);assert.match(run.reason,/Frozen policy/);assert.equal(f.spawned.length,1);f.db.close();
});

test('restart before stop confirmation cannot launch overlapping replacement work',async()=>{
  let active=true;const f=fixture({async status(){return active?'running':'idle';},async stop(){active=false;}});
  let run=await f.engine.start(brief);
  // Durable crash boundary: interruption saved, external stop not yet confirmed.
  run.desired='pause';run.condition='Stopping';run.interrupted='worker';f.store.save(run,run.revision);
  const restarted=new Engine(f.store,f.runtime);
  await assert.rejects(restarted.resume(run.id,run.revision),/Stop must reconcile/);assert.equal(f.spawned.length,1);assert.equal(active,true);
  run=await restarted.advance(run.id);assert.equal(run.condition,'Paused');assert.equal(active,false);
  await restarted.resume(run.id,run.revision);assert.equal(f.spawned.length,2);f.db.close();
});

test('G3 requires Kubernetes request, run, generation and lease binding',async()=>{
  const f=fixture();let run=await f.engine.start(brief);run=await f.engine.advance(run.id);
  run.checks[0]!.isolation={backend:'kubernetes-job',version:1,requestDigest:digest(validationRequest(run,brief.checks[0]!)),
    namespace:'validation',jobName:'job',jobUid:'job-uid',podUid:'pod-uid',image:`registry.example/check@sha256:${'d'.repeat(64)}`,
    runId:run.id,generation:run.generation,lease:run.lease,repository:brief.repository,base:brief.base};
  assert.equal(evaluate(run,'G3').outcome,'allow');
  for(const field of ['runId','generation','lease','repository','base','requestDigest','jobUid','podUid']) {
    const altered=structuredClone(run);(altered.checks[0]!.isolation as any)[field]=field==='generation'?99:'';
    assert.equal(evaluate(altered,'G3').outcome,'needs_attention',field);
  }
  f.db.close();
});
