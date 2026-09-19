// SPDX-License-Identifier: Apache-2.0
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { digest } from './model.ts';
const sha=z.string().regex(/^[a-f0-9]{40}$/);
const ref=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_/-]{0,150}$/).refine(s=>!s.includes('//')&&!s.endsWith('/'));
const permitFields=z.object({
 id:z.string().uuid(),repository:z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
 runId:z.string().min(1).max(160),generation:z.number().int().positive(),lease:z.string().min(1).max(160),
 ownerThreadId:z.string().min(1).max(160),scopeDigest:z.string().length(64),evidenceDigest:z.string().length(64),
 base:sha,head:sha,tree:sha,baseBranch:ref,branch:ref,previousHead:sha.nullable(),
 supersedes:z.string().uuid().nullable(),expiresAt:z.string().datetime(),
 title:z.string().min(1).max(200),body:z.string().max(30000),
 evidence:z.array(z.string().url().refine(s=>s.startsWith('https://'))).min(1).max(30),
}).strict();
export const publicationPermit=permitFields.refine(p=>p.baseBranch!==p.branch&&p.head!==p.base);
export type PublicationPermit=z.infer<typeof publicationPermit>;
export const publicationIdentity=permitFields.pick({repository:true,runId:true,generation:true,lease:true,ownerThreadId:true,scopeDigest:true,evidenceDigest:true,base:true,head:true,tree:true}).strip();
export type PublicationIdentity=z.infer<typeof publicationIdentity>;
export interface PublishedPull {number:number;url:string;head:string;base:string;baseBranch:string;branch:string;body:string;title:string;state:'open'|'closed';}
export interface PublicationReceipt {status:'verified';number:number;url:string;head:string;observedAt:string;identity:PublicationIdentity;}
export interface PublicationAdapter {
 prepareObjects?(permit:PublicationPermit,bundle:{data:string;sha256:string}):Promise<void>;
 verifyObjects(permit:PublicationPermit):Promise<void>;
 head(repository:string,branch:string):Promise<string|null>;
 push(permit:PublicationPermit):Promise<void>;
 pulls(permit:PublicationPermit):Promise<PublishedPull[]>;
 create(permit:PublicationPermit,body:string):Promise<void>;
 update(permit:PublicationPermit,pr:PublishedPull,body:string):Promise<void>;
}
interface Row {permit:string;phase:string;receipt:string|null;revoked:number;}
/** Only the dedicated publisher host instantiates this class. Its single socket
 * listener serializes operations; no worker can reach its socket, DB or credentials. */
export class Publisher {
 private busy=false;
 constructor(private readonly db:Database.Database,private readonly adapter:PublicationAdapter,private readonly current:(permit:PublicationPermit)=>Promise<boolean>) {
  db.exec(`CREATE TABLE IF NOT EXISTS codeops_publications (id TEXT PRIMARY KEY, permit TEXT NOT NULL, digest TEXT NOT NULL, phase TEXT NOT NULL, receipt TEXT, revoked INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS codeops_publication_revocations (id TEXT PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS codeops_publication_branches (branch_key TEXT PRIMARY KEY, permit_id TEXT NOT NULL)`);
 }
 private row(id:string):Row|undefined {return this.db.prepare('SELECT permit,phase,receipt,revoked FROM codeops_publications WHERE id=?').get(id) as Row|undefined;}
 get(id:string):PublicationPermit {const row=this.row(id);if(!row) throw Error('Unknown permit');return publicationPermit.parse(JSON.parse(row.permit));}
 admit(raw:unknown):void {
  if(this.busy) throw Error('Publication in progress');
  const permit=publicationPermit.parse(raw), hash=digest(permit);
  if(Date.parse(permit.expiresAt)<=Date.now()) throw Error('Expired permit');
  this.db.transaction(()=>{
   if(this.db.prepare('SELECT id FROM codeops_publication_revocations WHERE id=?').get(permit.id)) throw Error('Revoked permit');
   const prior=this.row(permit.id);
   if(prior) {if(digest(JSON.parse(prior.permit))!==hash) throw Error('Permit identity drift');return;}
   const key=`${permit.repository}:${permit.branch}`;
   const active=this.db.prepare('SELECT permit_id FROM codeops_publication_branches WHERE branch_key=?').get(key) as {permit_id:string}|undefined;
   if(active) {
    const row=this.row(active.permit_id)!, previous=publicationPermit.parse(JSON.parse(row.permit));
    if(permit.supersedes!==previous.id||row.phase!=='verified'||!row.receipt||row.revoked||permit.previousHead!==previous.head||permit.runId!==previous.runId||permit.ownerThreadId!==previous.ownerThreadId||permit.baseBranch!==previous.baseBranch||permit.generation<previous.generation) throw Error('Unverified or unrelated publication predecessor');
   } else if(permit.supersedes||permit.previousHead) throw Error('New publication must create a new branch');
   this.db.prepare("INSERT INTO codeops_publications (id,permit,digest,phase) VALUES (?,?,?,'admitted')").run(permit.id,JSON.stringify(permit),hash);
   this.db.prepare('INSERT INTO codeops_publication_branches VALUES (?,?) ON CONFLICT(branch_key) DO UPDATE SET permit_id=excluded.permit_id').run(key,permit.id);
  })();
 }
 revoke(id:string):void {
  z.string().uuid().parse(id);
  this.db.transaction(()=>{
   this.db.prepare('INSERT OR IGNORE INTO codeops_publication_revocations VALUES (?)').run(id);
   this.db.prepare('UPDATE codeops_publications SET revoked=1 WHERE id=?').run(id);
  })();
 }
 /** Recover provider effects using reads only; persist the resulting local receipt. */
 async recover(id:string):Promise<PublicationReceipt|null> {
  const row=this.row(id);
  if(!row||!['create-attempting','create-unknown','update-attempting','verified'].includes(row.phase)) return null;
  const p=this.get(id),prior=row.receipt?JSON.parse(row.receipt) as PublicationReceipt:null;
  await this.fence(p);
  const prs=await this.adapter.pulls(p);
  const body=`${p.body}\n\nEvidence:\n${p.evidence.map(url=>`- ${url}`).join('\n')}\n\n<!-- codeops-publication:${digest(p)} -->`;
  const predecessor=p.supersedes?this.row(p.supersedes):undefined;
  const expectedNumber=prior?.number??(predecessor?.receipt?(JSON.parse(predecessor.receipt) as PublicationReceipt).number:undefined);
  const markers=[`<!-- codeops-publication:${digest(p)} -->`];
  if(predecessor) markers.push(`<!-- codeops-publication:${digest(JSON.parse(predecessor.permit))} -->`);
  if(prs.length!==1||(expectedNumber!==undefined&&prs[0]!.number!==expectedNumber)||!markers.some(marker=>prs[0]!.body.includes(marker))) throw Error('Recorded PR outcome unknown or ownership drift');
  this.match(p,prs[0]!);
  if(await this.adapter.head(p.repository,p.branch)!==p.head||await this.adapter.head(p.repository,p.baseBranch)!==p.base) throw Error('Live publication drift');
  await this.fence(p);
  // An exact owned PR with incomplete text can use the normal idempotent update.
  if(prs[0]!.body!==body||prs[0]!.title!==p.title) return null;
  const receipt:PublicationReceipt={status:'verified',number:prs[0]!.number,url:prs[0]!.url,head:p.head,identity:publicationIdentity.parse(p),observedAt:new Date().toISOString()};
  this.db.prepare("UPDATE codeops_publications SET phase='verified',receipt=? WHERE id=?").run(JSON.stringify(receipt),id);
  return receipt;
 }
 async publish(id:string,bundle?:{data:string;sha256:string}):Promise<PublicationReceipt> {
  if(this.busy) throw Error('Publication in progress');this.busy=true;
  try {
   const row=this.row(id);if(!row) throw Error('No operator publication authority');
   const permit=this.get(id);
   const marker=`<!-- codeops-publication:${digest(permit)} -->`;
   const body=`${permit.body}\n\nEvidence:\n${permit.evidence.map(url=>`- ${url}`).join('\n')}\n\n${marker}`;
   await this.fence(permit);
   if(bundle) {if(!this.adapter.prepareObjects) throw Error('Object ingestion unavailable');await this.adapter.prepareObjects(permit,bundle);}
   await this.adapter.verifyObjects(permit);
   if(await this.adapter.head(permit.repository,permit.baseBranch)!==permit.base) throw Error('Base drift');
   let head=await this.adapter.head(permit.repository,permit.branch);
   // Inspect existing PR ownership BEFORE updating its branch.
   let prs=await this.adapter.pulls(permit);
   if(prs.length>1) throw Error('Duplicate pull requests');
   const previous=permit.supersedes?this.row(permit.supersedes):undefined;
   if(previous) {
    const receipt=JSON.parse(previous.receipt!) as PublicationReceipt;
    const allowedMarkers=[marker,`<!-- codeops-publication:${digest(JSON.parse(previous.permit))} -->`];
    if(prs.length!==1||prs[0]!.number!==receipt.number||!allowedMarkers.some(m=>prs[0]!.body.includes(m))) throw Error('PR ownership drift');
   } else if(prs.length===1&&!prs[0]!.body.includes(marker)) throw Error('PR ownership drift');
   if(prs[0]&&(prs[0].state!=='open'||prs[0].baseBranch!==permit.baseBranch||prs[0].branch!==permit.branch||prs[0].head!==head||prs[0].base!==permit.base)) throw Error('PR identity drift');
   if(head!==permit.head) {
    if(!['admitted','push-attempting'].includes(row.phase)) throw Error('Remote branch drift after publication attempt');
    if(head!==permit.previousHead) throw Error('Remote branch ownership drift');
    this.phase(id,'push-attempting');await this.fence(permit);await this.adapter.push(permit);
    head=await this.adapter.head(permit.repository,permit.branch);if(head!==permit.head) throw Error('Push not verified');
   }
   // A durable effect intent or receipt survives every incomplete inventory.
   // Only phases before the first PR effect may advance to branch-verified.
   if(['admitted','push-attempting','branch-verified'].includes(row.phase)) this.phase(id,'branch-verified');
   prs=await this.adapter.pulls(permit);if(prs.length>1) throw Error('Duplicate pull requests');
   if(prs.length===0) {
    if(previous) throw Error('Owned PR disappeared');
    if(row.receipt||!['admitted','push-attempting','branch-verified'].includes(row.phase)) throw Error('PR outcome unknown; fresh readback required');
    this.phase(id,'create-attempting');await this.fence(permit);
    try {await this.adapter.create(permit,body);} catch {this.phase(id,'create-unknown');throw Error('PR create outcome unknown');}
    prs=await this.adapter.pulls(permit);
   }
   if(prs.length!==1) throw Error('PR not verified');let pr=prs[0]!;this.match(permit,pr);
   if(row.receipt&&pr.number!==(JSON.parse(row.receipt) as PublicationReceipt).number) throw Error('Recorded PR identity drift');
   const priorMarker=previous?`<!-- codeops-publication:${digest(JSON.parse(previous.permit))} -->`:marker;
   if(!pr.body.includes(marker)&&!pr.body.includes(priorMarker)) throw Error('PR ownership drift');
   if(pr.body!==body||pr.title!==permit.title) {
    await this.fence(permit);this.phase(id,'update-attempting');await this.adapter.update(permit,pr,body);
    const live=await this.adapter.pulls(permit);if(live.length!==1||live[0]!.number!==pr.number) throw Error('PR update unknown');pr=live[0]!;this.match(permit,pr);
   }
   if(pr.body!==body||pr.title!==permit.title||await this.adapter.head(permit.repository,permit.branch)!==permit.head||await this.adapter.head(permit.repository,permit.baseBranch)!==permit.base) throw Error('Live publication drift');
   await this.fence(permit);
   const receipt:PublicationReceipt={status:'verified',number:pr.number,url:pr.url,head:permit.head,observedAt:new Date().toISOString(),identity:publicationIdentity.parse(permit)};
   this.db.prepare("UPDATE codeops_publications SET phase='verified',receipt=? WHERE id=?").run(JSON.stringify(receipt),id);return receipt;
  } finally {this.busy=false;}
 }
 private async fence(permit:PublicationPermit) {
  const row=this.row(permit.id), active=this.db.prepare('SELECT permit_id FROM codeops_publication_branches WHERE branch_key=?').get(`${permit.repository}:${permit.branch}`) as {permit_id:string}|undefined;
  if(!row||row.revoked||Date.parse(permit.expiresAt)<=Date.now()||active?.permit_id!==permit.id||!await this.current(permit)) throw Error('Publication authority revoked or identity stale');
 }
 private phase(id:string,phase:string) {this.db.prepare('UPDATE codeops_publications SET phase=? WHERE id=?').run(phase,id);}
 private match(p:PublicationPermit,pr:PublishedPull) {
  if(pr.state!=='open'||pr.head!==p.head||pr.base!==p.base||pr.branch!==p.branch||pr.baseBranch!==p.baseBranch) throw Error('PR identity drift');
 }
}
