// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {identity,hash,validateManifest,ensureRef,cleanup,fixturePullEvent} from './ownership.mjs';
import {prepare} from './candidate.mjs';
const manifest=()=>{const id=identity('example/repository','123');const digest=hash('candidate');return {schema:'codeops.publication-fixture/v1',identity:id,pinnedBase:'1'.repeat(40),base:'2'.repeat(40),head:'3'.repeat(40),tree:'4'.repeat(40),trustedSource:'5'.repeat(40),workflowSha:'6'.repeat(40),bundleSha256:hash('bundle'),candidateSha256:digest,marker:`<!-- codeops-fixture:${id.key}:${digest} -->`,createdAt:'2026-01-01T00:00:00.000Z',expiresAt:'2026-01-02T00:00:00.000Z',pr:7};};
function fixture(m=manifest()){
 const refs=new Map([[m.identity.base,m.base],[m.identity.head,m.head]]),calls=[];
 const pr={number:7,state:'open',merged_at:null,body:m.marker,head:{repo:{full_name:m.identity.repository},ref:m.identity.head,sha:m.head},base:{repo:{full_name:m.identity.repository},ref:m.identity.base,sha:m.base}};
 const api={repository:m.identity.repository,async ref(n){return refs.get(n)??null;},async createRef(n,s){calls.push('create');refs.set(n,s);},async verifyOwner(){calls.push('verify');},async finishedRun(){return true;},async pulls(){return [pr];},async pull(){return pr;},async close(){calls.push('close');pr.state='closed';},async deleteRef(n,s){assert.equal(refs.get(n),s);calls.push(n);refs.delete(n);},async markClean(){calls.push('clean');}};
 return {m,refs,calls,pr,api};
}
test('identity is stable across attempts and separates repository/run',()=>{
 assert.deepEqual(identity('example/repository','123'),identity('example/repository',123));
 assert.notEqual(identity('example/repository','123').key,identity('example/other','123').key);
 assert.notEqual(identity('example/repository','123').key,identity('example/repository','124').key);
 assert.throws(()=>identity('example/repository','../main'));assert.throws(()=>validateManifest({...manifest(),identity:{...manifest().identity,head:'main'}},'example/repository'));
});
test('actual Git candidate is deterministic and contains no workflow',t=>{
 const root=mkdtempSync(join(tmpdir(),'publication-candidate-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const input={repository:'example/repository',runId:'123',pinnedBase:'1'.repeat(40),trustedSource:'2'.repeat(40),createdAt:'2026-01-01T00:00:00.000Z'};
 const a=prepare(input,join(root,'one')),b=prepare(input,join(root,'two'));assert.deepEqual(a,b);assert.notEqual(a.base,a.head);assert.equal(hash(Buffer.from(a.bundle,'base64')),a.bundleSha256);
 assert.match(a.content,/publication-qualification/);
});
test('unknown create is reconciled and duplicates are idempotent',async()=>{
 const f=fixture();let writes=0;f.api.createRef=async(n,s)=>{writes++;f.refs.set(n,s);throw Error('response lost');};
 await ensureRef(f.api,'owned','a');await ensureRef(f.api,'owned','a');assert.equal(writes,1);
 await assert.rejects(ensureRef(f.api,'owned','b'),/collision/);assert.equal(writes,1);
});
test('cleanup reconciles lost close/delete responses and repeated execution',async()=>{
 const f=fixture();f.api.close=async()=>{f.pr.state='closed';throw Error('lost close');};f.api.deleteRef=async(n,s)=>{assert.equal(f.refs.get(n),s);f.refs.delete(n);throw Error('lost deletion');};
 await cleanup(f.api,f.m);await cleanup(f.api,f.m);assert.equal(f.refs.size,0);assert.equal(f.pr.state,'closed');
});
test('ref drift, duplicate PR, ownership drift and cleanup failure retain evidence',async()=>{
 for(const change of [f=>f.refs.set(f.m.identity.head,'9'.repeat(40)),f=>f.api.pulls=async()=>[f.pr,f.pr],f=>f.pr.body='human PR',f=>f.pr.base.ref='main']){
  const f=fixture();change(f);await assert.rejects(cleanup(f.api,f.m));assert.equal(f.refs.size,2);assert.equal(f.pr.state,'open');
 }
 const f=fixture();f.api.deleteRef=async()=>{throw Error('denied');};await assert.rejects(cleanup(f.api,f.m),/denied/);assert.equal(f.refs.size,2);assert(!f.calls.includes('clean'));
});
test('expiry requires durable owner, expired lease and terminal run',async()=>{
 const f=fixture();await assert.rejects(cleanup(f.api,f.m,{expired:true,now:0}),/not expired/);
 f.api.finishedRun=async()=>false;await assert.rejects(cleanup(f.api,f.m,{expired:true}),/still active/);
 f.api.finishedRun=async()=>true;f.api.verifyOwner=async()=>{throw Error('checkpoint drift');};await assert.rejects(cleanup(f.api,f.m,{expired:true}),/checkpoint drift/);assert.equal(f.refs.size,2);
});
test('fixture PR suppression is based on exact reserved base and leaves ordinary PRs',()=>{
 const m=manifest();assert(fixturePullEvent({pull_request:{base:{ref:m.identity.base}}}));
 for(const ref of ['main','bb/exact-candidate-publication','bb-qualification/human/base'])assert(!fixturePullEvent({pull_request:{base:{ref}}}));
 const workflow=readFileSync(new URL('../../../.github/workflows/publication-qualification.yml',import.meta.url),'utf8');
 assert(!workflow.includes('pull_request_target:'));assert(!workflow.includes('pull_request:'));assert(workflow.includes('permissions: {}'));assert(workflow.includes('if: always()'));assert(workflow.includes('schedule:'));
 for(const name of ['ci.yml','prevention.yml']){const source=readFileSync(new URL('../../../.github/workflows/'+name,import.meta.url),'utf8');assert(source.includes("branches-ignore: ['bb-qualification/publication/**']"));}
});


test('known PR is read directly despite an empty filtered inventory',async()=>{
 const f=fixture();f.api.pulls=async()=>[];await cleanup(f.api,f.m);assert.equal(f.pr.state,'closed');assert.equal(f.refs.size,0);
 const drift=fixture();drift.api.pulls=async()=>[];drift.pr.base.ref='main';await assert.rejects(cleanup(drift.api,drift.m));assert.equal(drift.refs.size,2);
 const unknown=fixture();unknown.api.pulls=async()=>[];unknown.api.pull=async()=>{throw Error('unavailable');};await assert.rejects(cleanup(unknown.api,unknown.m),/unavailable/);assert.equal(unknown.refs.size,2);
});
test('unresolved PR create never licenses deletion of its refs',async()=>{
 const f=fixture();f.m.pr=null;f.m.createAttempted=true;f.api.pulls=async()=>[];
 await assert.rejects(cleanup(f.api,f.m),/outcome unresolved/);assert.equal(f.refs.size,2);
 f.m.createRejected=true;await cleanup(f.api,f.m);assert.equal(f.refs.size,0);
});


test('cross-repository manifest is rejected before ownership use or cleanup effects',async()=>{
 const f=fixture();
 const foreign={...f.m,identity:identity('example/other','123')};
 foreign.marker=`<!-- codeops-fixture:${foreign.identity.key}:${foreign.candidateSha256} -->`;
 // Prove the foreign manifest is internally valid; repository binding alone rejects it.
 assert.equal(validateManifest(foreign,'example/other'),foreign);
 const calls=[];
 const api=new Proxy(f.api,{get(target,key){
  const value=target[key];
  return typeof value==='function'?(...args)=>{calls.push(key);return value(...args);}:value;
 }});
 for(const expired of [false,true]){
  await assert.rejects(cleanup(api,foreign,{expired}),/Manifest repository differs from configured repository/);
 }
 assert.deepEqual(calls,[],'No run, ownership, PR or ref calls before rejection');
 assert.equal(f.refs.size,2);assert.equal(f.pr.state,'open');
});
