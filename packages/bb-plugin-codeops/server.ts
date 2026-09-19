// SPDX-License-Identifier: Apache-2.0
import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { briefSchema, digest, type Run } from './core/model.ts';
import { Store } from './core/store.ts';
import { Engine, type Runtime } from './core/engine.ts';
import { hostContract } from './host-contract.ts';

const command = z.discriminatedUnion('op',[
  z.object({op:z.literal('list')}).strict(),
  z.object({op:z.literal('start'),brief:briefSchema}).strict(),
  z.object({op:z.enum(['get','reconcile']),id:z.string().min(1)}).strict(),
  z.object({op:z.enum(['pause','resume','cancel']),id:z.string().min(1),revision:z.number().int().nonnegative()}).strict(),
]);
// JSON output is bounded by pagination and bounded admission fields.
export const rpcContract=defineRpcContract({command:{input:command,output:z.object({json:z.string().max(900000)}).strict()}});

export default function plugin(bb:BbPluginApi) {
  const store=new Store(bb.storage.database());
  const host=bb.hosts.experimental_client({contract:hostContract});
  async function target(run:Run) {
    const env=await bb.sdk.environments.get({environmentId:run.brief.environmentId});
    if(env.projectId!==run.brief.projectId||!env.path||env.status!=='ready'||env.lifecycle.phase!=='active'||!env.isWorktree) throw new Error('Ready isolated worktree required');
    return {env,input:{path:env.path,repository:run.brief.repository,base:run.brief.base}};
  }
  const runtime:Runtime={
    async admit(brief) {
      const parent=await bb.sdk.threads.get({threadId:brief.parentThreadId});
      if(parent.projectId!==brief.projectId||parent.environmentId!==brief.environmentId) throw new Error('Parent/environment identity mismatch');
      const env=await bb.sdk.environments.get({environmentId:brief.environmentId});
      if(env.projectId!==brief.projectId||!env.isWorktree||!env.managed||!env.path||env.status!=='ready') throw new Error('Ready managed worktree required');
      await host.call('identity',{path:env.path,repository:brief.repository,base:brief.base},{hostId:env.hostId});
    },
    async inspect(run) {const {env,input}=await target(run);return host.call('inspect',input,{hostId:env.hostId});},
    async spawn(run,action) {
      const reviewer=action.kind==='reviewer';const {env}=await target(run);
      const brief=[`CodeOps ${action.kind}. Run ${run.id}; generation ${run.generation}; lease ${run.lease}.`,
        `Outcome: ${run.brief.outcome}`,`Scope: ${JSON.stringify(run.brief.scope)}`,`Acceptance: ${JSON.stringify(run.brief.acceptance)}`,
        'No merge, release, deploy, infrastructure mutation, permission grants, or credential access. No publication. Keep authored content product-neutral.',
        reviewer ? `Independent scope-first advisory review. Before correctness findings, assess whether the cumulative mechanism is necessary and proportionate and whether a simpler existing alternative suffices. Findings must name a violated requirement, concrete impact, and smallest sufficient remedy. Do not add roadmap work. Do not modify files. This permission mode is NOT read-only enforcement.` : 'Implement only the frozen brief. Commit a clean candidate. Run required isolated checks where available; never claim tests you did not run. A completed turn is not task completion.',
        reviewer ? `Exact candidate ${run.candidate!.head}, tree ${run.candidate!.tree}. Evidence ${JSON.stringify(run.checks)}. Return ONLY JSON: {"candidate":"${run.candidate!.head}","tree":"${run.candidate!.tree}","scopeDigest":"${run.scopeDigest}","evidenceDigest":"${digest(run.checks)}","outcome":"accept|rework|uncertain","findings":[{"requirement":"...","impact":"...","remedy":"..."}],"scopeAssessment":"..."}. This is advisory; you cannot authorize effects.` : `Prior advisory findings: ${JSON.stringify(run.review?.findings??[])}`,
      ].join('\n');
      const thread=await bb.sdk.threads.spawn({projectId:run.brief.projectId,parentThreadId:run.brief.parentThreadId,
        environment:reviewer?{type:'host',hostId:env.hostId,workspace:{type:'managed-worktree',baseBranch:{kind:'named',name:run.candidate!.head}}}:{type:'reuse',environmentId:env.id},
        permissionMode:'accept-edits',title:`CodeOps ${action.kind} ${run.id.slice(0,8)}`,prompt:brief,
        pluginMetadata:{runId:run.id,actionKey:action.key,generation:run.generation,lease:run.lease,scopeDigest:run.scopeDigest,candidate:run.candidate?.head??null},
      });return thread.id;
    },
    async find(run,action) {
      const matches:string[]=[];
      for(let offset=0;offset<10000;offset+=100) {
        const page=await bb.sdk.threads.list({projectId:run.brief.projectId,parentThreadId:run.brief.parentThreadId,originPluginId:bb.pluginId,includeHidden:true,limit:100,offset});
        for(const thread of page) {
          const m=await bb.sdk.threads.getPluginMetadata({threadId:thread.id});
          if(m.runId===run.id&&m.actionKey===action.key&&m.lease===run.lease&&m.generation===action.generation) matches.push(thread.id);
        }
        if(page.length<100) return matches;
      }
      throw new Error('Correlation search exceeded bounded inventory');
    },
    async status(threadId) {const t=await bb.sdk.threads.get({threadId});return t.status==='active'||t.status==='starting'?'running':t.status==='idle'?'idle':'failed';},
    async output(threadId) {return (await bb.sdk.threads.output({threadId})).output??'';},
    async stop(threadId) {await bb.sdk.threads.stop({threadId});},
    async checks(run) {
      const {env,input}=await target(run);const checks=[];
      for(const check of run.brief.checks) checks.push(await host.call('check',{...input,candidate:run.candidate!,check},{hostId:env.hostId,timeoutMs:180000}));
      return checks;
    },
    async attention(run) {bb.realtime.publish('changed',{id:run.id});await bb.sdk.threads.markUnread({threadId:run.brief.parentThreadId});},
  };
  const engine=new Engine(store,runtime);
  async function execute(raw:unknown):Promise<{json:string}> {
    const c=command.parse(raw);let result:unknown;
    if(c.op==='list') result=store.list().map(r=>({id:r.id,revision:r.revision,outcome:r.brief.outcome,stage:r.stage,condition:r.condition,reason:r.reason,head:r.candidate?.head??null}));
    else if(c.op==='start') result=await engine.start(c.brief);
    else if(c.op==='get') result=store.get(c.id);
    else if(c.op==='reconcile') result=await engine.advance(c.id);
    else if(c.op==='resume') result=await engine.resume(c.id,c.revision);
    else if ('revision' in c) result=await engine.pause(c.id,c.revision,c.op==='cancel');
    bb.realtime.publish('changed',{});return {json:JSON.stringify(result)};
  }
  bb.rpc.register(rpcContract,{command:execute});
  bb.cli.register({name:'codeops',summary:'Run bounded CodeOps work and inspect durable evidence',commands:[{name:'command',summary:'Execute a JSON command',usage:'bb codeops command <json>'}],
    async run(argv) {try {if(argv.length!==2||argv[0]!=='command') return {exitCode:1,stderr:'Usage: bb codeops command <json>'};return {exitCode:0,stdout:(await execute(JSON.parse(argv[1]!))).json};} catch {return {exitCode:1,stderr:'Command rejected. Check schema, native identity and run revision.'};}},
  });
  // Tools may request authorized implementation. None can impersonate a human or submit evidence.
  bb.agents.registerTool({name:'codeops_command',description:'Inspect or progress a CodeOps run within its frozen implementation-only policy. Cannot grant authority or publish.',parameters:command,
    async execute(input) {return (await execute(input)).json;},
  });
  async function reconcile() {
    let cursor=0;
    for(;;) {const page=store.pending(cursor);if(!page.runs.length) break;cursor=page.cursor;for(const run of page.runs) await engine.advance(run.id);}
  }
  bb.events.on('thread.idle',async()=>{await reconcile();bb.realtime.publish('changed',{});});
  bb.events.on('thread.failed',async()=>{await reconcile();bb.realtime.publish('changed',{});});
  bb.background.schedule('reconcile','* * * * *',reconcile);
}
