// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const workflowPath='.github/workflows/publication-qualification.yml';
export const hash=value=>createHash('sha256').update(typeof value==='string'||value instanceof Uint8Array?value:JSON.stringify(value)).digest('hex');
export function identity(repository,runId) {
 assert.match(repository,/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);assert.match(String(runId),/^[1-9][0-9]{0,19}$/);
 const key=hash(`${repository.toLowerCase()}\n${workflowPath}\n${runId}`).slice(0,32);
 const prefix=`bb-qualification/publication/${key}`;
 return {repository,runId:String(runId),workflowPath,key,owner:`${prefix}/owner`,base:`${prefix}/base`,head:`${prefix}/head`};
}
export function validateManifest(m,repository) {
 assert.match(repository,/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
 assert.equal(m.identity.repository,repository,'Manifest repository differs from configured repository');
 assert.equal(m.schema,'codeops.publication-fixture/v1');
 assert.deepEqual(m.identity,identity(m.identity.repository,m.identity.runId));
 for(const key of ['pinnedBase','base','head','tree','trustedSource','workflowSha'])assert.match(m[key],/^[a-f0-9]{40}$/);
 assert(m.pr===null||(Number.isSafeInteger(m.pr)&&m.pr>0),'Invalid PR identity');
 assert.match(m.bundleSha256,/^[a-f0-9]{64}$/);assert.match(m.candidateSha256,/^[a-f0-9]{64}$/);
 assert.equal(m.marker,`<!-- codeops-fixture:${m.identity.key}:${m.candidateSha256} -->`);
 assert(Number.isFinite(Date.parse(m.createdAt)));assert.equal(Date.parse(m.expiresAt)-Date.parse(m.createdAt),86400000);
 return m;
}
export function ownPull(m,p) {
 assert.equal(p.head.repo.full_name,m.identity.repository);assert.equal(p.base.repo.full_name,m.identity.repository);
 assert.equal(p.head.ref,m.identity.head);assert.equal(p.base.ref,m.identity.base);
 assert.equal(p.head.sha,m.head);assert.equal(p.base.sha,m.base);
 assert(p.body?.includes(m.marker),'PR ownership marker drift');
 if(m.pr!==null)assert.equal(p.number,m.pr,'Recorded PR identity drift');
 assert.equal(p.merged_at,null,'Fixture PR was merged; stop cleanup');
 return p;
}
// Effects must expose live readback; exceptions are never interpreted as absence.
export async function ensureRef(api,name,sha) {
 const existing=await api.ref(name);
 if(existing!==null){assert.equal(existing,sha,'Ref collision/drift');return;}
 try {await api.createRef(name,sha);} catch(error) {
  const observed=await api.ref(name);if(observed!==sha)throw error;
 }
 assert.equal(await api.ref(name),sha,'Ref create not verified');
}
export async function cleanup(api,m,{expired=false,now=Date.now()}={}) {
 validateManifest(m,api.repository);
 if(expired){assert(now>=Date.parse(m.expiresAt),'Fixture not expired');assert(await api.finishedRun(m),'Run is still active or identity drifted');}
 // Ownership authority is the durable, exact manifest, not a prefix match.
 await api.verifyOwner(m);
 const pulls=await api.pulls(m);assert(pulls.length<=1,'Duplicate fixture PRs');
 const head=await api.ref(m.identity.head),base=await api.ref(m.identity.base);
 assert(head===null||head===m.head,'Head drift; retain all evidence');assert(base===null||base===m.base,'Base drift; retain all evidence');
 if(m.pr!==null&&pulls.length)assert.equal(pulls[0].number,m.pr,'Recorded PR inventory drift');
 const recorded=m.pr!==null?await api.pull(m.pr):pulls[0];
 if(!recorded&&m.createAttempted&&!m.createRejected)throw Error('PR create outcome unresolved; retain refs and ownership');
 if(recorded){
  const pr=ownPull(m,recorded);
  if(pr.state==='open'){
   try{await api.close(pr.number);}catch(error){const read=ownPull(m,await api.pull(pr.number));if(read.state!=='closed')throw error;}
   assert.equal(ownPull(m,await api.pull(pr.number)).state,'closed');
  }
 }
 // Atomic Git compare-and-delete: REST DELETE has no expected-SHA precondition.
 // Delete exact refs only; no wildcard or history rewriting.
 for(const [name,sha] of [[m.identity.head,m.head],[m.identity.base,m.base]]) {
  const current=await api.ref(name);if(current===null)continue;assert.equal(current,sha,'Cleanup ref drift');
  try{await api.deleteRef(name,sha);}catch(error){if(await api.ref(name)!==null)throw error;}
  assert.equal(await api.ref(name),null,'Ref deletion not verified');
 }
 await api.markClean(m); // Durable tombstone kept for bounded expiry reconciliation.
 return {status:'clean',key:m.identity.key,pr:pulls[0]?.number??m.pr,headDeleted:true,baseDeleted:true};
}
export function fixturePullEvent(event) {
 const pr=event.pull_request;
 return Boolean(pr&&/^bb-qualification\/publication\/[a-f0-9]{32}\/base$/.test(pr.base?.ref??''));
}
