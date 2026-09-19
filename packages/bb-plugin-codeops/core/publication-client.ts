// SPDX-License-Identifier: Apache-2.0
import { request } from 'node:http';
import { z } from 'zod';
import { digest, evaluate, type Run } from './model.ts';
import { publicationIdentity, type PublicationIdentity, type PublicationReceipt } from './publication.ts';
export function identityForPublication(run:Run):PublicationIdentity {
 if(run.desired!=='run'||!run.candidate||!['Publish','AwaitMerge'].includes(run.stage)||['G1','G3','G4'].some(g=>evaluate(run,g as 'G1'|'G3'|'G4').outcome!=='allow')) throw Error('Exact publication evidence unavailable');
 const repository=new URL(run.brief.repository).pathname.slice(1).replace(/\.git$/,'');
 return publicationIdentity.parse({repository,runId:run.id,generation:run.generation,lease:run.lease,ownerThreadId:run.brief.parentThreadId,scopeDigest:run.scopeDigest,evidenceDigest:digest(run.checks),base:run.brief.base,head:run.candidate.head,tree:run.candidate.tree});
}
export async function publisherRequest(socketPath:string,operation:string,payload:unknown):Promise<unknown> {
 if(!socketPath.startsWith('/')||!['publish','admit','revoke','status','review','inbox','ack','reviews','recover'].includes(operation)) throw Error('Invalid publisher request');
 const body=JSON.stringify(payload);if(body.length>25*1024*1024) throw Error('Publisher request too large');
 return new Promise((resolve,reject)=>{
  const req=request({socketPath,path:`/${operation}`,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},response=>{
   let data='';response.setEncoding('utf8');response.on('data',chunk=>{data+=chunk;if(data.length>2_000_000) req.destroy(Error('Response too large'));});
   response.on('end',()=>{try {if(response.statusCode!==200) throw Error('Publisher unavailable or rejected request');resolve(JSON.parse(data));} catch {reject(Error('Publisher unavailable or rejected request'));}});
  });
  req.setTimeout(240_000,()=>req.destroy(Error('Publisher response unknown')));req.on('error',()=>reject(Error('Publisher response unknown')));req.end(body);
 });
}
export async function publishCandidate(socketPath:string,id:string,run:Run,bundle:{data:string;sha256:string}):Promise<PublicationReceipt> {
 const identity=identityForPublication(run);
 const receipt=z.object({status:z.literal('verified'),number:z.number().int().positive(),url:z.string().url(),head:z.string(),observedAt:z.string().datetime(),identity:publicationIdentity}).strict().parse(await publisherRequest(socketPath,'publish',{id,identity,bundle}));
 if(digest(receipt.identity)!==digest(identity)||receipt.head!==identity.head||!receipt.url.startsWith(`https://github.com/${identity.repository}/pull/`)) throw Error('Publisher receipt identity mismatch');
 return receipt;
}
