// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { briefSchema, digest, evaluate, reviewSchema, type Action, type Brief, type Candidate, type Check, type Run } from './model.ts';
import { Store } from './store.ts';
import { identityForPublication } from './publication-client.ts';
import type { PublicationReceipt } from './publication.ts';
export interface Runtime {
  admit(brief:Brief):Promise<void>;
  inspect(run:Run):Promise<Candidate>;
  spawn(run:Run,action:Action):Promise<string>;
  find(run:Run,action:Action):Promise<string[]>;
  status(threadId:string):Promise<'running'|'idle'|'failed'>;
  output(threadId:string):Promise<string>;
  stop(threadId:string):Promise<void>;
  checks(run:Run):Promise<Check[]>;
  attention(run:Run):Promise<void>;
  publish?(run:Run,permitId:string):Promise<PublicationReceipt>;
  recoverPublication?(permitId:string):Promise<PublicationReceipt|null>;
  revokePublication?(permitId:string):Promise<void>;
}
export class Engine {
  private busy = new Set<string>();
  constructor(readonly store:Store,private readonly runtime:Runtime) {}
  private save(run:Run):Run { return this.store.save(run,run.revision); }
  private gate(run:Run,gate:Parameters<typeof evaluate>[1]):boolean {
    const record=evaluate(run,gate);if(!run.decisions.some(d=>d.gate===record.gate&&d.candidate===record.candidate&&d.evidenceDigest===record.evidenceDigest&&d.outcome===record.outcome&&d.reason===record.reason)) run.decisions.push(record);run.reason=record.reason;
    return record.outcome==='allow';
  }
  async start(raw:unknown):Promise<Run> {
    const brief=briefSchema.parse(raw); const key=`${brief.projectId}:${brief.key}`;
    const existing=this.store.byKey(key);
    if (existing) { if (existing.scopeDigest!==digest(brief)) throw new Error('Duplicate key has different frozen scope');return existing; }
    await this.runtime.admit(brief);
    const now=new Date().toISOString();
    const authority={source:'admitted-brief' as const,projectId:brief.projectId,effects:['implement','validate','review'] as ['implement','validate','review'],digest:digest({projectId:brief.projectId,effects:['implement','validate','review']})};
    const run:Run={id:randomUUID(),revision:0,brief,scopeDigest:digest(brief),authority,policy:'codeops/bb-v1',stage:'Plan',condition:'Waiting',desired:'run',reason:'Ready',generation:1,lease:randomUUID(),corrections:0,candidate:null,checks:[],review:null,actions:[],decisions:[],createdAt:now,updatedAt:now};
    this.gate(run,'G0');this.gate(run,'G1');
    // No awaits between uniqueness readback and insert. Concurrent admission is deduplicated here.
    const duplicate=this.store.byKey(key);
    if (duplicate) { if (duplicate.scopeDigest!==run.scopeDigest) throw new Error('Duplicate scope');return duplicate; }
    this.store.create(run);return this.advance(run.id);
  }
  async advance(id:string):Promise<Run> {
    if (this.busy.has(id)) return this.store.get(id);
    this.busy.add(id);
    let run=this.store.get(id);
    try {
      if (['Cancelled','Completed'].includes(run.condition)) return run;
      if (run.desired!=='run') return await this.settleStop(run);
      if(evaluate(run,'G1').outcome!=='allow') return await this.block(run,'Frozen policy or scope identity mismatch');
      await this.runtime.admit(run.brief); // Revocation and identity drift fence every execution.
      if(run.interrupted) {
        const kind=run.interrupted;delete run.interrupted;run.generation++;run.lease=randomUUID();
        if(kind==='worker') {run.stage='Implement';run.candidate=null;run.checks=[];run.review=null;}
        return await this.launch(run,kind);
      }
      const authorized=run.actions.find(a=>a.state==='authorized');
      if(authorized) return await this.block(run,'Interrupted before effect attempt; explicit inspection required');
      const pending=run.actions.find(a=>a.state==='attempting'||a.state==='unknown');
      if (pending) {
        if (pending.kind==='worker'||pending.kind==='reviewer') {
          const ids=pending.threadId?[pending.threadId]:await this.runtime.find(run,pending);
          if (ids.length!==1) return await this.block(run,ids.length ? 'Duplicate correlated children; reconcile manually':'Spawn outcome unknown; do not retry');
          pending.threadId=ids[0];pending.state='succeeded';this.save(run);
        } else return await this.block(run,'Uncertain action requires readback; no automatic retry');
      }
      const child=[...run.actions].reverse().find(a=>a.generation===run.generation&&(a.kind==='worker'||a.kind==='reviewer')&&a.threadId);
      if (child) {
        const status=await this.runtime.status(child.threadId!);
        if (status==='running') {run.condition='Running';return this.save(run);}
        if (status==='failed') return await this.block(run,'Native child failed; inspect its thread');
      }
      if (run.stage==='Plan') { run.stage='Implement';return await this.launch(run,'worker'); }
      if (run.stage==='Implement') {
        run.candidate=await this.runtime.inspect(run);run.checks=[];run.review=null;
        if (!this.gate(run,'G2')) return await this.block(run,run.reason);
        run.stage='Validate';this.save(run);
      }
      if (run.candidate && digest(await this.runtime.inspect(run))!==digest(run.candidate)) {
        run.candidate=null;run.checks=[];run.review=null;run.stage='Implement';return await this.block(run,'Candidate changed; validation and review invalidated');
      }
      if (run.stage==='Validate') {
        if(run.actions.filter(a=>a.kind==='checks').length>=run.brief.correctionLimit+2) return await this.block(run,'Check attempt budget exhausted');
        const action=this.action(run,'checks');this.save(run);action.state='attempting';this.save(run);
        try { run.checks=await this.runtime.checks(run);action.state='succeeded'; }
        catch { action.state='unknown';return await this.block(run,'Check outcome unknown or launcher unavailable; inspect termination before retry; no evidence accepted'); }
        if (!this.gate(run,'G3')) return await this.block(run,run.reason);
        run.stage='Critic';return await this.launch(run,'reviewer');
      }
      if (run.stage==='Critic') {
        if (!child || child.kind!=='reviewer') return await this.block(run,'Independent review thread missing');
        const report=await this.runtime.output(child.threadId!);
        try {run.review=reviewSchema.parse(JSON.parse(report));} catch {return await this.block(run,'Reviewer did not return a valid structured advisory report');}
        if (!this.gate(run,'G4')) {
          if (run.review.outcome==='rework' && run.corrections<run.brief.correctionLimit && run.review.candidate===run.candidate?.head && run.review.evidenceDigest===digest(run.checks) && run.review.scopeDigest===run.scopeDigest && run.review.tree===run.candidate?.tree) {
            run.corrections++;run.generation++;run.lease=randomUUID();run.stage='Implement';run.candidate=null;run.checks=[];
            return await this.launch(run,'worker');
          }
          return await this.block(run,run.reason);
        }
        run.stage='Publish';this.gate(run,'G5');return await this.block(run,run.reason);
      }
      return run;
    } catch { return await this.block(this.store.get(id),'Authority, identity, or runtime readback failed; inspect environment and retry reconciliation'); }
    finally {this.busy.delete(id);}
  }
  private action(run:Run,kind:Action['kind']):Action {
    const action:Action={key:`${run.id}:${run.generation}:${kind}:${run.actions.length}`,kind,state:'authorized',generation:run.generation};run.actions.push(action);return action;
  }
  private async launch(run:Run,kind:'worker'|'reviewer'):Promise<Run> {
    const action=this.action(run,kind);run.condition='Running';this.save(run);
    action.state='attempting';this.save(run); // Claim BEFORE the external spawn.
    try {action.threadId=await this.runtime.spawn(run,action);action.state='succeeded';return this.save(run);}
    catch {action.state='unknown';return this.block(run,'Spawn outcome unknown; reconcile correlation before continuing');}
  }
  private async block(run:Run,reason:string):Promise<Run> {
    const changed=run.condition!=='NeedsAttention'||run.reason!==reason;
    run.condition='NeedsAttention';run.reason=reason;
    if(!run.decisions.some(d=>d.gate==='exception'&&d.reason===reason&&d.candidate===(run.candidate?.head??null))) run.decisions.push({...evaluate(run,'exception'),reason});this.save(run);
    if (changed) await this.runtime.attention(run).catch(()=>{});
    return run;
  }
  private async settleStop(run:Run):Promise<Run> {
    if(run.actions.some(a=>a.kind==='checks'&&(a.state==='unknown'||a.state==='attempting'))) return this.block(run,'Check termination unknown; cannot finish cancellation');
    for (const action of run.actions.filter(a=>(a.kind==='worker'||a.kind==='reviewer')&&a.state!=='failed')) {
      if(action.state==='authorized') {action.state='failed';this.save(run);continue;}
      if(!action.threadId) {
        const matches=await this.runtime.find(run,action);
        if(matches.length!==1) return this.block(run,'Unattached or duplicate child must be reconciled before cancellation');
        action.threadId=matches[0];action.state='succeeded';this.save(run);
      }
      try {
        const active=await this.runtime.status(action.threadId!)==='running';
        if(active&&run.desired==='pause'&&action.generation===run.generation) {run.interrupted=action.kind as 'worker'|'reviewer';this.save(run);}
        await this.runtime.stop(action.threadId!);if(await this.runtime.status(action.threadId!)==='running') return this.block(run,'Stop not confirmed');}
      catch {return this.block(run,'Stop failed or unknown; cancellation not complete');}
    }
    run.condition=run.desired==='cancel'?'Cancelled':'Paused';run.reason=run.desired==='cancel'?'All known children stopped':'Paused';return this.save(run);
  }
  async publish(id:string,revision:number,permitId:string):Promise<Run> {
    if(this.busy.has(id)) throw Error('Run is executing');this.busy.add(id);
    try {
      const run=this.store.get(id);if(run.revision!==revision) throw Error('Stale run revision');
      if(!this.runtime.publish) throw Error('Trusted publication boundary unavailable');
      const identity=identityForPublication(run);
      if(run.publicationAttempt&&(run.publicationAttempt.permitId!==permitId||digest(run.publicationAttempt.identity)!==digest(identity))) throw Error('Unresolved publication identity; reconcile the recorded permit');
      if(run.publicationAttempt&&this.runtime.recoverPublication) {
        const recovered=await this.runtime.recoverPublication(permitId);
        if(recovered) {
          if(digest(recovered.identity)!==digest(identity)||recovered.head!==identity.head) throw Error('Publication receipt identity drift');
          run.publication={permitId,receipt:recovered};delete run.publicationAttempt;run.stage='AwaitMerge';run.condition='NeedsAttention';
          run.reason='Publication recovered by live readback; merge, release and deployment remain manual';this.save(run);return run;
        }
      }
      await this.runtime.admit(run.brief);
      if(digest(await this.runtime.inspect(run))!==digest(run.candidate)) throw Error('Candidate drift');
      run.publicationAttempt={permitId,identity,phase:'attempting'};
      run.condition='NeedsAttention';run.reason='Publication response pending; reconcile the recorded permit after restart';this.save(run);
      let receipt:PublicationReceipt;
      try {receipt=await this.runtime.publish(run,permitId);} catch {
        run.publicationAttempt.phase='unknown';run.reason='Publication outcome unknown; retry the recorded permit for fresh readback';
        this.save(run);await this.runtime.attention(run).catch(()=>{});return run;
      }
      if(digest(receipt.identity)!==digest(identity)) throw Error('Publication receipt identity drift');
      run.publication={permitId,receipt};delete run.publicationAttempt;run.stage='AwaitMerge';run.condition='NeedsAttention';
      run.reason='Exact candidate published; merge, release and deployment remain manual';
      this.save(run);await this.runtime.attention(run).catch(()=>{});return run;
    } finally {this.busy.delete(id);}
  }
  async abandonPublication(id:string,revision:number):Promise<Run> {
    if(this.busy.has(id)) throw Error('Run is executing');this.busy.add(id);
    try {
      const run=this.store.get(id);if(run.revision!==revision) throw Error('Stale run revision');
      const attempt=run.publicationAttempt;if(!attempt) throw Error('No unresolved publication');
      if(!this.runtime.revokePublication) throw Error('Trusted revocation unavailable');
      await this.runtime.revokePublication(attempt.permitId);
      (run.abandonedPublications??=[]).push({permitId:attempt.permitId,identity:attempt.identity,revokedAt:new Date().toISOString()});
      delete run.publicationAttempt;run.reason='Permit revoked; possible prior effects retained for operator investigation';return this.save(run);
    } finally {this.busy.delete(id);}
  }
  async pause(id:string,revision:number,cancel=false):Promise<Run> {
    if (this.busy.has(id)) throw new Error('Run is executing; retry pause after current bounded action');
    this.busy.add(id);
    try {
      const run=this.store.get(id);if (run.revision!==revision) throw new Error('Stale run revision');
      if(run.condition==='Cancelled') return run;
      run.desired=cancel?'cancel':'pause';run.condition='Stopping';run.reason='Stop requested';this.save(run);
      return await this.settleStop(run);
    } finally {this.busy.delete(id);}
  }
  async resume(id:string,revision:number):Promise<Run> {
    if(this.busy.has(id)) throw new Error('Run is executing');
    const run=this.store.get(id);if(run.revision!==revision) throw new Error('Stale run revision');
    if(run.desired==='cancel'||run.condition==='Cancelled') throw new Error('Cancellation cannot resume');
    if(run.desired==='pause'&&run.condition!=='Paused') throw new Error('Stop must reconcile before resume');
    run.desired='run';run.condition='Waiting';this.save(run);return this.advance(id);
  }
}
