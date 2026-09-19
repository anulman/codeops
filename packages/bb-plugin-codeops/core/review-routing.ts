// SPDX-License-Identifier: Apache-2.0
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { GithubReader } from './github-observations.ts';

const repository=z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const binding=z.object({repository,number:z.number().int().positive(),runId:z.string().min(1),generation:z.number().int().positive(),lease:z.string().min(1),base:z.string().regex(/^[a-f0-9]{40}$/),head:z.string().regex(/^[a-f0-9]{40}$/),ownerThreadId:z.string().min(1)}).strict();
export type ReviewBinding=z.infer<typeof binding>;
const record=z.object({id:z.number().int().positive(),user:z.object({id:z.number().int().positive()}),html_url:z.string().url(),body:z.string().nullable().optional()}).passthrough();
/** Durable inbox only. Comment text is untrusted evidence, never a command or a grant. */
export class ReviewRouter {
  constructor(private readonly db:Database.Database,private readonly github:GithubReader,
    private readonly currentBinding:(repository:string,number:number)=>Promise<ReviewBinding|null>,
    private readonly notifyOwner:(threadId:string)=>Promise<void>,private readonly ownActorIds:ReadonlySet<number>) {
    db.exec(`CREATE TABLE IF NOT EXISTS codeops_review_deliveries (delivery TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL)`);
  }
  async receive(input:{delivery:string;event:string;signature:string;body:Buffer}, secret:string):Promise<'ignored'|'delivered'|'duplicate'> {
    if(!/^[A-Za-z0-9-]{1,100}$/.test(input.delivery)||input.body.length>1_000_000||!/^sha256=[a-f0-9]{64}$/.test(input.signature)||!secret) throw new Error('Invalid delivery');
    const expected=createHmac('sha256',secret).update(input.body).digest();
    if(!timingSafeEqual(expected,Buffer.from(input.signature.slice(7),'hex'))) throw new Error('Invalid signature');
    const hash=createHash('sha256').update(input.event).update('\0').update(input.body).digest('hex');
    const prior=this.db.prepare('SELECT digest,state,body FROM codeops_review_deliveries WHERE delivery=?').get(input.delivery) as {digest:string;state:string;body:string}|undefined;
    if(prior?.digest!==undefined&&prior.digest!==hash) throw new Error('Delivery identity drift');
    if(prior?.state==='delivered') return 'duplicate';
    if(!['pull_request_review','pull_request_review_comment','issue_comment'].includes(input.event)) return 'ignored';
    const event=JSON.parse(input.body.toString('utf8'));
    const actions=input.event==='pull_request_review'?['submitted','edited','dismissed']:['created','edited'];
    if(!actions.includes(event.action)) return 'ignored';
    const repo=repository.parse(event.repository?.full_name);
    if(input.event==='issue_comment'&&!event.issue?.pull_request) return 'ignored';
    const number=z.number().int().positive().parse(event.pull_request?.number??event.issue?.number);
    const owner=await this.currentBinding(repo,number);if(!owner) return 'ignored';
    binding.parse(owner);
    if(prior&&JSON.stringify(JSON.parse(prior.body).owner)!==JSON.stringify(owner)) throw new Error('Pending delivery owner changed');
    if(owner.repository!==repo||owner.number!==number) throw new Error('Owner identity drift');
    const id=z.number().int().positive().parse((input.event==='pull_request_review'?event.review:event.comment)?.id);
    const path=input.event==='pull_request_review'?`/pulls/${number}/reviews/${id}`:input.event==='pull_request_review_comment'?`/pulls/comments/${id}`:`/issues/comments/${id}`;
    // Deleted objects cannot supply fresh content and are not routed.
    const live=record.parse(await this.github.get(repo,path));
    const pr=z.object({number:z.number(),head:z.object({sha:z.string()}),base:z.object({sha:z.string()})}).parse(await this.github.get(repo,`/pulls/${number}`));
    if(pr.number!==number||pr.head.sha!==owner.head||pr.base.sha!==owner.base) throw new Error('Stale publication identity');
    if(live&&live.id!==id) throw new Error('Comment identity drift');
    if(live&&this.ownActorIds.has(live.user.id)) return 'ignored';
    // REST comment endpoints are repository-scoped, not PR-scoped. Verify membership.
    if(live&&input.event==='pull_request_review_comment'&&live.pull_request_url!==`https://api.github.com/repos/${repo}/pulls/${number}`) throw new Error('Review comment ownership drift');
    if(live&&input.event==='issue_comment'&&live.issue_url!==`https://api.github.com/repos/${repo}/issues/${number}`) throw new Error('Issue comment ownership drift');
    if(JSON.stringify(await this.currentBinding(repo,number))!==JSON.stringify(owner)) throw new Error('Owner changed during readback');
    const receipt={authority:false,owner,event:input.event,action:event.action,objectId:id,observedAt:new Date().toISOString(),url:live?.html_url??null,body:live?.body?.slice(0,16000)??null};
    this.db.transaction(()=>{
      const concurrent=this.db.prepare('SELECT digest,body FROM codeops_review_deliveries WHERE delivery=?').get(input.delivery) as {digest:string;body:string}|undefined;
      if(concurrent&&(concurrent.digest!==hash||JSON.stringify(JSON.parse(concurrent.body).owner)!==JSON.stringify(owner))) throw Error('Delivery identity drift');
      this.db.prepare("INSERT INTO codeops_review_deliveries VALUES (?,?,'pending',?) ON CONFLICT(delivery) DO NOTHING").run(input.delivery,hash,JSON.stringify(receipt));
    })();
    // markUnread is idempotent. A crash/response loss retries this notification,
    // never launches work or interprets the text as an instruction.
    await this.notifyOwner(owner.ownerThreadId);
    this.db.prepare("UPDATE codeops_review_deliveries SET state='delivered' WHERE delivery=? AND digest=?").run(input.delivery,hash);
    return 'delivered';
  }
}
