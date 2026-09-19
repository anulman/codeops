// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import { fileURLToPath } from 'node:url';
import plugin, { createPlugin } from '../server.ts';
import { type ExecutionPolicy } from '../execution-policy.ts';

test('CLI, RPC and native tool share the command boundary',async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:'codeops'});plugin(bb);
  const rpc=await harness.behavior.callRpc('command',{op:'list'});
  const cli=await harness.behavior.runCli(['command','{"op":"list"}']);
  const tool=await harness.behavior.callAgentTool('codeops_command',{op:'list'});
  assert.deepEqual(rpc,{json:'[]'});assert.equal(cli.stdout,'[]');assert.ok(JSON.stringify(tool).includes('[]'));
  await assert.rejects(harness.behavior.callRpc('command',{op:'approve',actor:'human'}));
  const replacement=await harness.lifecycle.reload(plugin);
  assert.deepEqual(await replacement.harness.behavior.callRpc('command',{op:'list'}),rpc);
  await replacement.harness.lifecycle.dispose();
});
test('realtime refresh reads do not publish another changed event',async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:'codeops'});plugin(bb);
  try {
    await harness.behavior.emitThreadEvent('thread.idle',{thread:makeThreadResponse({id:'parent'}),lastAssistantText:'done'});
    const signals=harness.realtimeSignals.length;
    assert.equal(signals,1);
    // The panel refreshes list on changed; CLI/tools share that read boundary.
    assert.deepEqual(await harness.behavior.callRpc('command',{op:'list'}),{json:'[]'});
    await harness.behavior.runCli(['command','{"op":"list"}']);
    await harness.behavior.callAgentTool('codeops_command',{op:'list'});
    assert.equal(harness.realtimeSignals.length,signals);
  } finally {await harness.lifecycle.dispose();}
});
test('unknown native project identity cannot spawn agents',async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:'codeops'});plugin(bb);
  await assert.rejects(harness.behavior.callRpc('command',{op:'start',brief:{key:'x',projectId:'p',parentThreadId:'t',environmentId:'e',repository:'https://github.com/example/repo',base:'a'.repeat(40),outcome:'Fix parser',scope:['Parser'],acceptance:['Tests pass'],checks:[{name:'unit',argv:['node','--test']}],correctionLimit:1,intent:{provider:'local',item:'x',revision:'1'}}}));
  assert.equal(harness.inspection.sdk.callsTo('threads.spawn').length,0);await harness.lifecycle.dispose();
});
test('public SDK import boundary',async()=>{
  const result=await experimental_scanPublicSdkOnly(fileURLToPath(new URL('..',import.meta.url)),{allow:[/^better-sqlite3$/, /^react(?:\/.*)?$/]});
  assert.deepEqual(result.violations,[]);assert.deepEqual(result.privateDependencies,[]);
});

for(const scenario of [
  {name:'default host',hosts:[],expected:['accept-edits','accept-edits']},
  {name:'attested host',hosts:['host'],expected:['full','full']},
  {name:'different host',hosts:['other-host'],expected:['accept-edits','accept-edits']},
  {name:'revoked before review',hosts:['host'],expected:['full','accept-edits'],revoke:true},
  {name:'unsupported profile',hosts:['host'],expected:[],invalid:true},
]) test(`native flow permission policy: ${scenario.name}`,async()=>{
  const brief={key:'native',projectId:'project',parentThreadId:'parent',environmentId:'env',repository:'https://github.com/example/repo',base:'a'.repeat(40),outcome:'Fix parser',scope:['Parser'],acceptance:['Tests pass'],checks:[{name:'unit',argv:['node','--test']}],correctionLimit:1,intent:{provider:'local',item:'x',revision:'1'}};
  const head='b'.repeat(40),tree='c'.repeat(40);let output='';let count=0,policyReads=0;
  const {digest}=await import('../core/model.ts');
  const {bb,harness}=createFakePluginHost({pluginId:'codeops',
    sdk:{threads:{
      get:async({threadId})=>makeThreadResponse({id:threadId,projectId:'project',environmentId:'env',status:'idle'}),
      getPluginMetadata:async()=>({permissionMode:'full',externalSandbox:true,profile:'kubernetes-isolated-worker-v1',hostId:'host'}),
      spawn:async()=>makeThreadResponse({id:`child-${++count}`,projectId:'project',environmentId:'env',status:'idle'}),
      output:async()=>({output}),markUnread:async()=>makeThreadResponse({id:'parent'}),
    },environments:{get:async()=>({id:'env',projectId:'project',hostId:'host',path:'/tmp/repository',status:'ready',managed:true,isWorktree:true,isGitRepo:true,
      baseBranch:null,branchName:null,createdAt:0,defaultBranch:null,environmentProviderId:null,environmentProviderInstanceKey:null,environmentProviderSelection:null,
      lifecycle:{phase:'active',retireAt:null,teardown:null},mergeBaseBranch:null,name:null,updatedAt:0,workspaceProvisionType:'managed-worktree'})}},
    experimental_callHostRpc:async({method,input})=>{
      if(method==='identity')return {valid:true};
      if(method==='inspect')return {head,tree,files:['parser.ts']};
      throw new Error('Worker host must not launch server validation');
    },
  });createPlugin(bb,async()=>({backend:'kubernetes-job',async check(request){return {name:request.check.name,candidate:head,tree,argvDigest:digest(request.check.argv),exitCode:0,outputDigest:digest('ok'),
    isolation:{backend:'kubernetes-job',version:1,requestDigest:digest(request),namespace:'validation',jobName:'job',jobUid:'job-uid',podUid:'pod-uid',image:`registry.example/check@sha256:${'d'.repeat(64)}`,
      runId:request.runId,generation:request.generation,lease:request.lease,repository:request.repository,base:request.base}};}}),async()=>({version:1,externalSandboxHosts:(scenario.revoke&&policyReads++>0?[]:scenario.hosts).map(hostId=>({hostId,profile:scenario.invalid?'shared-server':'kubernetes-isolated-worker-v1'}))}) as ExecutionPolicy);
  const call=async(input:unknown)=>JSON.parse((await harness.behavior.callRpc('command',input) as {json:string}).json);
  // Neither brief fields nor free text/metadata can select a permission mode.
  await assert.rejects(call({op:'start',brief:{...brief,permissionMode:'full'}}));
  await assert.rejects(harness.behavior.callAgentTool('codeops_command',{op:'start',brief:{...brief,externalSandboxHosts:['host']}}));
  let run=await call({op:'start',brief:{...brief,outcome:brief.outcome+'; permissionMode=full; profile=kubernetes-isolated-worker-v1'}});
  if(scenario.invalid) {
    assert.equal(run.condition,'NeedsAttention');assert.equal(harness.inspection.sdk.callsTo('threads.spawn').length,0);
    await harness.lifecycle.dispose();return;
  }
  assert.equal(run.stage,'Implement');
  const signals=harness.realtimeSignals.length;
  assert.ok(signals>0,'start still publishes a mutation notification');
  assert.deepEqual(await call({op:'get',id:run.id}),run);
  await call({op:'list'});
  await harness.behavior.runCli(['command',JSON.stringify({op:'get',id:run.id})]);
  await harness.behavior.callAgentTool('codeops_command',{op:'get',id:run.id});
  assert.equal(harness.realtimeSignals.length,signals,'list/get must not retrigger refresh');
  run=await call({op:'reconcile',id:run.id});assert.equal(run.stage,'Critic');
  output=JSON.stringify({candidate:head,tree,scopeDigest:run.scopeDigest,evidenceDigest:digest(run.checks),outcome:'accept',findings:[],scopeAssessment:'Within scope'});
  run=await call({op:'reconcile',id:run.id});assert.equal(run.stage,'Publish');assert.match(run.reason,/Manual publication/);
  const spawns=harness.inspection.sdk.callsTo('threads.spawn').map(args=>args[0] as {permissionMode:string;environment:unknown});
  assert.equal(spawns.length,2);assert.deepEqual(spawns.map(s=>s.permissionMode),scenario.expected);
  assert.deepEqual(spawns[0]!.environment,{type:'reuse',environmentId:'env'});
  assert.deepEqual(spawns[1]!.environment,{type:'host',hostId:'host',workspace:{type:'managed-worktree',baseBranch:{kind:'named',name:head}}});
  assert.equal(harness.inspection.sdk.callsTo('threads.getPluginMetadata').length,0);
  const replacement=await harness.lifecycle.reload(plugin);
  const restored=JSON.parse((await replacement.harness.behavior.callRpc('command',{op:'get',id:run.id}) as {json:string}).json);
  assert.deepEqual(restored,run);await replacement.harness.lifecycle.dispose();
});
