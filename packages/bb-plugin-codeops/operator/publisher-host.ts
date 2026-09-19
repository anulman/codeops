// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { readFile, lstat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { Publisher, publicationIdentity, type PublicationAdapter } from '../core/publication.ts';
import { GithubPublication } from '../core/github-publication.ts';
import { digest, type Run } from '../core/model.ts';
import { identityForPublication } from '../core/publication-client.ts';
import { observeMilestones, type GithubReader } from '../core/github-observations.ts';
import { ReviewRouter, type ReviewBinding } from '../core/review-routing.ts';
const absolute=z.string().refine(value=>value.startsWith('/'));
const configSchema=z.object({socket:absolute,database:absolute,authorityDatabase:absolute,repositories:z.array(z.object({name:z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),directory:absolute,credentialVariable:z.string().regex(/^CODEOPS_GITHUB_[A-Z0-9_]+$/)}).strict()).min(1),webhookSecretVariable:z.string().regex(/^CODEOPS_WEBHOOK_[A-Z0-9_]+$/),ownActorIds:z.array(z.number().int().positive()).min(1)}).strict();
async function privatePath(path:string,directory=false) {
 const stat=await lstat(path);
 if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile())||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0) throw Error('Publisher paths must be private and owned by this account');
}
/** Called only after acquiring the OS flock; exported for a disposable fixture. */
export async function servePublisher(configPath:string,adapterOverride?:PublicationAdapter&GithubReader) {
 await privatePath(configPath);const config=configSchema.parse(JSON.parse(await readFile(configPath,'utf8')));
 await privatePath(dirname(config.socket),true);await privatePath(dirname(config.database),true);
 for(const repository of config.repositories) await privatePath(repository.directory,true);
 if(new Set(config.repositories.map(r=>r.name)).size!==config.repositories.length) throw Error('Duplicate repository configuration');
 // Only the flock holder may remove a stale socket after a crash.
 try {const stat=await lstat(config.socket);if(!stat.isSocket()||stat.uid!==process.getuid?.()) throw Error('Socket path ownership drift');await unlink(config.socket);} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
 process.umask(0o077);
 try {await privatePath(config.database);} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
 const db=new Database(config.database);db.pragma('journal_mode = WAL');
 const adapter=adapterOverride??new GithubPublication(new Map(config.repositories.map(r=>[r.name,{directory:r.directory,credentialVariable:r.credentialVariable}])));
 await privatePath(config.authorityDatabase);
 const authority=new Database(config.authorityDatabase,{readonly:true,fileMustExist:true});
 const publisher=new Publisher(db,adapter,async permit=>{
  // Canonical durable run read for EVERY effect, independent of request identity.
  const row=authority.prepare('SELECT body FROM codeops_runs WHERE id=?').get(permit.runId) as {body:string}|undefined;
  if(!row) return false;
  try {return digest(identityForPublication(JSON.parse(row.body) as Run))===digest(publicationIdentity.parse(permit));} catch {return false;}
 });
 const findOwner=async(repository:string,number:number):Promise<ReviewBinding|null>=>{
  const rows=db.prepare("SELECT p.permit,p.receipt FROM codeops_publications p JOIN codeops_publication_branches b ON p.id=b.permit_id WHERE p.phase='verified' AND p.revoked=0").all() as {permit:string;receipt:string}[];
  for(const row of rows) {const permit=JSON.parse(row.permit),receipt=JSON.parse(row.receipt);if(permit.repository===repository&&receipt.number===number) return {repository,number,runId:permit.runId,generation:permit.generation,lease:permit.lease,base:permit.base,head:permit.head,ownerThreadId:permit.ownerThreadId};}
  return null;
 };
 // Notification delivery is durable here. The trusted BB client marks the existing
 // owner unread before acknowledging. No comment text enters an agent prompt.
 db.exec('CREATE TABLE IF NOT EXISTS codeops_review_notifications (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0)');
 const router=new ReviewRouter(db,adapter,findOwner,async owner=>{db.prepare('INSERT INTO codeops_review_notifications (owner,revision) VALUES (?,1) ON CONFLICT(owner) DO UPDATE SET revision=revision+1').run(owner);},new Set(config.ownActorIds));
 let queue=Promise.resolve();
 const server=createServer((request,response)=>{
  const work=async()=>{
   try {
    if(request.method!=='POST') throw Error('Unsupported method');let bytes=0;const chunks:Buffer[]=[];
    for await(const chunk of request) {bytes+=chunk.length;if(bytes>25*1024*1024) throw Error('Request too large');chunks.push(chunk);}
    const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));let result:unknown;
    if(request.url==='/admit') {publisher.admit(input);result={admitted:true};}
    else if(request.url==='/revoke') {const {id}=z.object({id:z.string().uuid()}).strict().parse(input);publisher.revoke(id);result={id,revoked:true};}
    else if(request.url==='/recover') {result=await publisher.recover(z.object({id:z.string().uuid()}).strict().parse(input).id);}
    else if(request.url==='/publish') {
     const value=z.object({id:z.string().uuid(),identity:publicationIdentity,bundle:z.object({data:z.string().max(24*1024*1024),sha256:z.string().length(64)}).strict()}).strict().parse(input);
     if(digest(value.identity)!==digest(publicationIdentity.parse(publisher.get(value.id)))) throw Error('Requested publication identity drift');
     result=await publisher.publish(value.id,value.bundle);
    } else if(request.url==='/status') {
     const value=z.object({id:z.string().uuid()}).strict().parse(input),permit=publisher.get(value.id);
     const row=db.prepare("SELECT receipt FROM codeops_publications WHERE id=? AND phase='verified'").get(value.id) as {receipt:string}|undefined;
     if(!row) throw Error('Publication not verified');result=await observeMilestones(adapter,permit.repository,JSON.parse(row.receipt).number,permit.head);
    } else if(request.url==='/review') {
     const value=z.object({delivery:z.string(),event:z.string(),signature:z.string(),body:z.string().max(1_000_000)}).strict().parse(input);
     const secret=process.env[config.webhookSecretVariable];if(!secret) throw Error('Webhook authority unavailable');
     result={result:await router.receive({...value,body:Buffer.from(value.body)},secret)};
    } else if(request.url==='/reviews') {
     const value=z.object({id:z.string().uuid()}).strict().parse(input),permit=publisher.get(value.id);
     result=db.prepare("SELECT body FROM codeops_review_deliveries WHERE json_extract(body,'$.owner.runId')=? ORDER BY rowid DESC LIMIT 30").all(permit.runId).map(row=>JSON.parse((row as {body:string}).body));
    } else if(request.url==='/inbox') {
     z.object({}).strict().parse(input);
     result=db.prepare('SELECT owner,revision FROM codeops_review_notifications WHERE revision>acknowledged ORDER BY owner LIMIT 100').all();
    } else if(request.url==='/ack') {
     const value=z.object({owner:z.string(),revision:z.number().int().positive()}).strict().parse(input);
     db.prepare('UPDATE codeops_review_notifications SET acknowledged=MAX(acknowledged,?) WHERE owner=? AND revision>=?').run(value.revision,value.owner,value.revision);result={acknowledged:true};
    } else throw Error('Unsupported operation');
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(result));
   } catch {response.writeHead(409,{'content-type':'application/json'});response.end('{"error":"Publisher rejected request or outcome unknown; reconcile exact identity"}');}
  };
  queue=queue.then(work,work);
 });
 server.requestTimeout=30_000;server.headersTimeout=10_000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.socket,()=>resolve());});
 return {server,db,async close(){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await queue;authority.close();db.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const configPath=process.argv[2];if(!configPath) throw Error('Usage: publisher-host.ts /private/config.json');
 if(process.argv[3]==='--locked') {
  await servePublisher(configPath);
 } else {
  await privatePath(configPath);
  const config=configSchema.parse(JSON.parse(await readFile(configPath,'utf8')));await privatePath(dirname(config.database),true);
  const child=spawn('flock',['--nonblock',`${config.database}.lock`,process.execPath,'--experimental-transform-types',fileURLToPath(import.meta.url),configPath,'--locked'],{stdio:'inherit'});
  child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
 }
}
