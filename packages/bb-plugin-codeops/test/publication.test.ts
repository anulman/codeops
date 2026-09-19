// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Publisher, type PublicationPermit, type PublicationAdapter, type PublishedPull } from '../core/publication.ts';
const permit:PublicationPermit={id:'12345678-1234-4234-8234-123456789abc',repository:'example/repository',runId:'run',generation:1,lease:'lease',ownerThreadId:'owner',scopeDigest:'1'.repeat(64),evidenceDigest:'2'.repeat(64),expiresAt:'2099-01-01T00:00:00.000Z',supersedes:null,base:'a'.repeat(40),head:'b'.repeat(40),tree:'c'.repeat(40),baseBranch:'main',branch:'candidate',previousHead:null,title:'Candidate',body:'Change',evidence:['https://example.test/evidence']};
function fixture(t:any) {
 const db=new Database(':memory:');t.after(()=>db.close());let loseUpdate=false,failUpdate=false;let head:string|null=null,prs:PublishedPull[]=[],pushes=0,creates=0,current=true,losePush=false,loseCreate=false,hide=false,wrongOwner=false;
 const adapter:PublicationAdapter={async verifyObjects(){},async head(_repo,branch){return branch==='main'?permit.base:head;},async push(p){pushes++;head=p.head;for(const pr of prs)pr.head=p.head;if(losePush) throw Error('response lost');},async pulls(){if(wrongOwner)for(const pr of prs)pr.body='unrelated';return hide?[]:prs;},async create(p,body){creates++;prs=[{number:1,url:'https://github.com/example/repository/pull/1',head:p.head,base:p.base,baseBranch:p.baseBranch,branch:p.branch,body,title:p.title,state:'open'}];if(loseCreate) throw Error('response lost');},async update(p,pr,body){if(failUpdate){failUpdate=false;throw Error('not applied');}pr.body=body;pr.title=p.title;if(loseUpdate)throw Error('response lost');}};
 const make=()=>new Publisher(db,adapter,async()=>current);
 return {make,failUpdate:()=>{failUpdate=true;},changeNumber:()=>{prs[0]!.number=2;},loseUpdate:()=>{loseUpdate=true;},changeTitle:()=>{prs[0]!.title='Old title';},wrongOwner:()=>{wrongOwner=true;},pushes:()=>pushes,creates:()=>creates,losePush:()=>{losePush=true;},loseCreate:()=>{loseCreate=true;},hide:()=>{hide=true;},drift:()=>{head='d'.repeat(40);},revoke:()=>{current=false;}};
}
test('exact publication converges without duplicate effects',async t=>{
 const f=fixture(t),p=f.make();p.admit(permit);await p.publish(permit.id);await f.make().publish(permit.id);assert.equal(f.pushes(),1);assert.equal(f.creates(),1);
});
test('lost push response recovers by exact remote head',async t=>{
 const f=fixture(t),p=f.make();p.admit(permit);f.losePush();await assert.rejects(p.publish(permit.id));await f.make().publish(permit.id);assert.equal(f.pushes(),1);
});
test('lost PR response recovers from live owned PR without creating again',async t=>{
 const f=fixture(t),p=f.make();p.admit(permit);f.loseCreate();await assert.rejects(p.publish(permit.id));await f.make().publish(permit.id);assert.equal(f.creates(),1);
});
test('unknown create with empty readback never repeats creation',async t=>{
 const f=fixture(t),p=f.make();p.admit(permit);f.loseCreate();await assert.rejects(p.publish(permit.id));f.hide();await assert.rejects(f.make().publish(permit.id),/unknown/);await assert.rejects(f.make().publish(permit.id),/unknown/);assert.equal(f.creates(),1);
});
test('branch drift and revoked authority prevent effects',async t=>{
 const f=fixture(t),p=f.make();p.admit(permit);f.drift();await assert.rejects(p.publish(permit.id),/drift/);assert.equal(f.pushes(),0);f.revoke();await assert.rejects(p.publish(permit.id),/revoked/);
});
test('permit identity and branch ownership cannot be silently replaced',t=>{
 const f=fixture(t),p=f.make();p.admit(permit);assert.throws(()=>p.admit({...permit,head:'e'.repeat(40)}),/identity drift/);assert.throws(()=>p.admit({...permit,id:'12345678-1234-4234-8234-123456789abd'}));
});

test('verified predecessor permits exact branch/PR update with new evidence',async t=>{
 const f=fixture(t),p=f.make();p.admit(permit);await p.publish(permit.id);
 const next={...permit,id:'12345678-1234-4234-8234-123456789abd',head:'e'.repeat(40),previousHead:permit.head,supersedes:permit.id,generation:2,lease:'next',title:'Revised candidate'};
 p.admit(next);const result=await p.publish(next.id);assert.equal(result.head,next.head);assert.equal(f.creates(),1);assert.equal(f.pushes(),2);
 await assert.rejects(p.publish(permit.id),/revoked|stale/);
});
test('ownership drift prevents even the branch update',async t=>{
 const f=fixture(t),p=f.make();p.admit(permit);await p.publish(permit.id);f.wrongOwner();
 const next={...permit,id:'12345678-1234-4234-8234-123456789abd',head:'e'.repeat(40),previousHead:permit.head,supersedes:permit.id};
 p.admit(next);await assert.rejects(p.publish(next.id),/ownership drift/);assert.equal(f.pushes(),1);
});
test('operator revocation and expiration reject further publication',async t=>{
 const f=fixture(t),p=f.make();assert.throws(()=>p.admit({...permit,expiresAt:'2000-01-01T00:00:00.000Z'}),/Expired/);
 p.admit(permit);p.revoke(permit.id);await assert.rejects(p.publish(permit.id),/revoked/);assert.equal(f.pushes(),0);
});

test('verified receipt survives missing inventory across repeated restarts',async t=>{
 const f=fixture(t),p=f.make();p.admit(permit);await p.publish(permit.id);f.hide();
 for(let attempt=0;attempt<2;attempt++) await assert.rejects(f.make().publish(permit.id),/unknown/);
 assert.equal(f.creates(),1);assert.equal(f.pushes(),1);
});
test('lost update response and missing inventory cannot recreate the PR',async t=>{
 const f=fixture(t),p=f.make();p.admit(permit);await p.publish(permit.id);f.changeTitle();f.loseUpdate();
 await assert.rejects(p.publish(permit.id));f.hide();
 for(let attempt=0;attempt<2;attempt++) await assert.rejects(f.make().publish(permit.id),/unknown/);
 assert.equal(f.creates(),1);assert.equal(f.pushes(),1);
});

test('read-only recovery after lost create needs no object ingestion or repeated mutation',async t=>{
 const f=fixture(t),p=f.make();p.admit(permit);f.loseCreate();await assert.rejects(p.publish(permit.id));
 const receipt=await f.make().recover(permit.id);assert.equal(receipt?.head,permit.head);assert.equal(f.creates(),1);assert.equal(f.pushes(),1);
 f.hide();await assert.rejects(f.make().recover(permit.id),/unknown/);assert.equal(f.creates(),1);
});
test('revocation of an unknown permit durably prevents later admission',t=>{
 const f=fixture(t);f.make().revoke(permit.id);assert.throws(()=>f.make().admit(permit),/Revoked/);
});

test('unapplied owned update remains safely retryable after read-only recovery',async t=>{
 const f=fixture(t),p=f.make();p.admit(permit);await p.publish(permit.id);
 const next={...permit,id:'12345678-1234-4234-8234-123456789abd',head:'e'.repeat(40),previousHead:permit.head,supersedes:permit.id,title:'Revised candidate'};
 p.admit(next);f.failUpdate();await assert.rejects(p.publish(next.id));assert.equal(await f.make().recover(next.id),null);
 await f.make().publish(next.id);assert.equal(f.creates(),1);assert.equal(f.pushes(),2);
});
test('successor recovery enforces the predecessor PR number',async t=>{
 const f=fixture(t),p=f.make();p.admit(permit);await p.publish(permit.id);
 const next={...permit,id:'12345678-1234-4234-8234-123456789abd',head:'e'.repeat(40),previousHead:permit.head,supersedes:permit.id,title:'Revised candidate'};
 p.admit(next);f.loseUpdate();await assert.rejects(p.publish(next.id));f.changeNumber();
 await assert.rejects(f.make().recover(next.id),/ownership drift/);assert.equal(f.creates(),1);
});
