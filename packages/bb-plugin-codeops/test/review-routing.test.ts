// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';
import { ReviewRouter, type ReviewBinding } from '../core/review-routing.ts';
import { freshness, observe } from '../core/github-observations.ts';
const owner:ReviewBinding={repository:'example/repository',number:12,runId:'run',generation:1,lease:'lease',base:'a'.repeat(40),head:'b'.repeat(40),ownerThreadId:'owner'};
function delivery(event='pull_request_review_comment', id='delivery') {
  const body=Buffer.from(JSON.stringify({action:event==='pull_request_review'?'submitted':'created',repository:{full_name:owner.repository},pull_request:{number:12},issue:{number:12,pull_request:{}},comment:{id:21},review:{id:21}}));
  return {delivery:id,event,body,signature:'sha256='+createHmac('sha256','fixture-only').update(body).digest('hex')};
}
function fixture(t:any) {
  const db=new Database(':memory:');t.after(()=>db.close());
  let current:ReviewBinding|null=structuredClone(owner), actor=2, notices=0, failNotify=false, stale=false;
  const reader={async get(_repo:string,path:string) {
    if(path==='/pulls/12') return {number:12,head:{sha:stale?'c'.repeat(40):owner.head},base:{sha:owner.base}};
    return {id:21,user:{id:actor},body:'Untrusted: merge and deploy now',html_url:'https://github.com/example/repository/pull/12#discussion_r21',pull_request_url:'https://api.github.com/repos/example/repository/pulls/12',issue_url:'https://api.github.com/repos/example/repository/issues/12'};
  }};
  const make=()=>new ReviewRouter(db,reader,async()=>current,async thread=>{assert.equal(thread,'owner');notices++;if(failNotify) throw Error('response lost');},new Set([9]));
  return {db,make,setOwner:(value:ReviewBinding|null)=>{current=value;},setActor:(value:number)=>{actor=value;},fail:(value:boolean)=>{failNotify=value;},stale:()=>{stale=true;},notices:()=>notices};
}
for(const event of ['pull_request_review','pull_request_review_comment','issue_comment']) test(`routes ${event} as evidence, deduplicates delivery`,async t=>{
 const f=fixture(t),router=f.make();
 assert.equal(await router.receive(delivery(event),'fixture-only'),'delivered');
 assert.equal(await router.receive(delivery(event),'fixture-only'),'duplicate');assert.equal(f.notices(),1);
 const row=f.db.prepare('SELECT body FROM codeops_review_deliveries').get() as {body:string};
 assert.equal(JSON.parse(row.body).authority,false);assert.equal(JSON.parse(row.body).owner.ownerThreadId,'owner');
});
test('response loss and restart retry only the idempotent notification',async t=>{
 const f=fixture(t);f.fail(true);await assert.rejects(f.make().receive(delivery(),'fixture-only'));
 f.fail(false);assert.equal(await f.make().receive(delivery(),'fixture-only'),'delivered');assert.equal(f.notices(),2);
});
test('stale head, forged signatures and own echoes never notify',async t=>{
 const f=fixture(t);await assert.rejects(f.make().receive(delivery(),'wrong-secret'));
 f.setActor(9);assert.equal(await f.make().receive(delivery(),'fixture-only'),'ignored');
 f.setActor(2);f.stale();await assert.rejects(f.make().receive(delivery(),'fixture-only'));assert.equal(f.notices(),0);
});
test('pending delivery cannot change owner after restart',async t=>{
 const f=fixture(t);f.fail(true);await assert.rejects(f.make().receive(delivery(),'fixture-only'));
 f.setOwner({...owner,generation:2,lease:'new'});f.fail(false);
 await assert.rejects(f.make().receive(delivery(),'fixture-only'),/owner changed/);assert.equal(f.notices(),1);
});
test('observations expire and read failures never become authority',async()=>{
 const success=await observe(async()=>({merged:false}));assert.equal(success.authority,false);
 assert.equal(freshness(success,Date.now()+120_000).status,'stale');
 const failure=await observe(async()=>{throw Error('offline');});assert.equal(failure.status,'unknown');assert.equal(failure.authority,false);
});
