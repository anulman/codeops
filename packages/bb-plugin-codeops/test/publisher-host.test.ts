// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../core/store.ts';
import { Engine, type Runtime } from '../core/engine.ts';
import { digest, type Brief, type Run } from '../core/model.ts';
import { identityForPublication, publisherRequest } from '../core/publication-client.ts';
import { servePublisher } from '../operator/publisher-host.ts';
const brief:Brief={key:'fixture',projectId:'project',parentThreadId:'owner',environmentId:'environment',repository:'https://github.com/example/repository',base:'a'.repeat(40),outcome:'Fix parser',scope:['Parser'],acceptance:['Reject invalid input'],checks:[{name:'unit',argv:['node','--test']}],correctionLimit:0,intent:{provider:'local',item:'fixture',revision:'1'}};
async function fixture(t:any) {
 const root=await mkdtemp(join(tmpdir(),'publisher-host-'));await chmod(root,0o700);
 const authorityPath=join(root,'authority.sqlite'),db=new Database(authorityPath);db.pragma('journal_mode = WAL');await chmod(authorityPath,0o600);
 const store=new Store(db);let current:Run;
 const candidate={head:'b'.repeat(40),tree:'c'.repeat(40),files:['parser.ts']};
 const runtime:Runtime={async admit(){},async inspect(){return candidate;},async spawn(run,action){current=run;return action.key;},async find(){return [];},async status(){return 'idle';},async output(){return JSON.stringify({candidate:candidate.head,tree:candidate.tree,scopeDigest:current.scopeDigest,evidenceDigest:digest(current.checks),outcome:'accept',findings:[],scopeAssessment:'Bounded fixture'});},async stop(){},async attention(){},async checks(run){return [{name:'unit',candidate:candidate.head,tree:candidate.tree,argvDigest:digest(brief.checks[0]!.argv),exitCode:0,outputDigest:digest('pass'),isolation:{backend:'bubblewrap',version:1}}];}};
 const engine=new Engine(store,runtime);let run=await engine.start(brief);run=await engine.advance(run.id);run=await engine.advance(run.id);
 const directory=join(root,'objects');await mkdir(directory,{mode:0o700});
 const config={socket:join(root,'publisher.sock'),database:join(root,'publisher.sqlite'),authorityDatabase:authorityPath,repositories:[{name:'example/repository',directory,credentialVariable:'CODEOPS_GITHUB_FIXTURE'}],webhookSecretVariable:'CODEOPS_WEBHOOK_FIXTURE',ownActorIds:[9]};
 const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 let adapterCalls=0;
 const fail=async()=>{adapterCalls++;throw Error('No real provider permitted in this test');};
 const adapter={verifyObjects:fail,prepareObjects:fail,head:fail,push:fail,pulls:fail,create:fail,update:fail,get:fail};
 let host=await servePublisher(configPath,adapter);
 t.after(async()=>{await host.close();db.close();await rm(root,{recursive:true,force:true});});
 const permit={id:'12345678-1234-4234-8234-123456789abc',...identityForPublication(run),baseBranch:'main',branch:'candidate',previousHead:null,supersedes:null,expiresAt:'2099-01-01T00:00:00.000Z',title:'Candidate',body:'Fixture',evidence:['https://example.test/evidence']};
 const call=(op:string,input:unknown)=>publisherRequest(config.socket,op,input);
 await call('admit',permit);
 return {call,permit,store,run,adapterCalls:()=>adapterCalls,host:()=>host,async restart(){await host.close();host=await servePublisher(configPath,adapter);}};
}
test('real private host re-reads cancelled canonical run after restart, not supplied identity',async t=>{
 const f=await fixture(t);const identity=identityForPublication(f.run);
 f.run.desired='cancel';f.run.condition='Cancelled';f.store.save(f.run,f.run.revision);await f.restart();
 await assert.rejects(f.call('publish',{id:f.permit.id,identity,bundle:{data:'Zml4dHVyZQ==',sha256:'0'.repeat(64)}}));
 assert.equal(f.adapterCalls(),0,'No provider or object-ingestion call after canonical revocation');
});
test('stale acknowledgement cannot hide a newer owner notification',async t=>{
 const f=await fixture(t),db=f.host().db;
 db.prepare('INSERT INTO codeops_review_notifications (owner,revision) VALUES (?,1)').run('owner');
 const stale=await f.call('inbox',{}) as {owner:string;revision:number}[];
 await f.call('ack',stale[0]);db.prepare('UPDATE codeops_review_notifications SET revision=revision+1 WHERE owner=?').run('owner');
 await f.call('ack',stale[0]);assert.deepEqual(await f.call('inbox',{}),[{owner:'owner',revision:2}]);
});
test('retained review evidence is readable without granting command authority',async t=>{
 const f=await fixture(t);const receipt={authority:false,owner:{runId:f.run.id},url:'https://github.com/example/repository/pull/1#discussion_r2',body:'Untrusted text'};
 f.host().db.prepare("INSERT INTO codeops_review_deliveries VALUES (?,?,'delivered',?)").run('delivery','digest',JSON.stringify(receipt));
 assert.deepEqual(await f.call('reviews',{id:f.permit.id}),[receipt]);
});
