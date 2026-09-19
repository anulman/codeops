// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import { fileURLToPath } from 'node:url';
import plugin from '../server.ts';

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
test('unknown native project identity cannot spawn agents',async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:'codeops'});plugin(bb);
  await assert.rejects(harness.behavior.callRpc('command',{op:'start',brief:{key:'x',projectId:'p',parentThreadId:'t',environmentId:'e',repository:'https://github.com/example/repo',base:'a'.repeat(40),outcome:'Fix parser',scope:['Parser'],acceptance:['Tests pass'],checks:[{name:'unit',argv:['node','--test']}],correctionLimit:1,intent:{provider:'local',item:'x',revision:'1'}}}));
  assert.equal(harness.inspection.sdk.callsTo('threads.spawn').length,0);await harness.lifecycle.dispose();
});
test('public SDK import boundary',async()=>{
  const result=await experimental_scanPublicSdkOnly(fileURLToPath(new URL('..',import.meta.url)),{allow:[/^better-sqlite3$/, /^react(?:\/.*)?$/]});
  assert.deepEqual(result.violations,[]);assert.deepEqual(result.privateDependencies,[]);
});

test('native SDK worker, host checks and reviewer reach manual publication',async()=>{
  const brief={key:'native',projectId:'project',parentThreadId:'parent',environmentId:'env',repository:'https://github.com/example/repo',base:'a'.repeat(40),outcome:'Fix parser',scope:['Parser'],acceptance:['Tests pass'],checks:[{name:'unit',argv:['node','--test']}],correctionLimit:1,intent:{provider:'local',item:'x',revision:'1'}};
  const head='b'.repeat(40),tree='c'.repeat(40);let output='';let count=0;
  const {digest}=await import('../core/model.ts');
  const {bb,harness}=createFakePluginHost({pluginId:'codeops',
    sdk:{threads:{
      get:async({threadId})=>makeThreadResponse({id:threadId,projectId:'project',environmentId:'env',status:'idle'}),
      spawn:async()=>makeThreadResponse({id:`child-${++count}`,projectId:'project',environmentId:'env',status:'idle'}),
      output:async()=>({output}),markUnread:async()=>makeThreadResponse({id:'parent'}),
    },environments:{get:async()=>({id:'env',projectId:'project',hostId:'host',path:'/tmp/repository',status:'ready',managed:true,isWorktree:true,isGitRepo:true,
      baseBranch:null,branchName:null,createdAt:0,defaultBranch:null,environmentProviderId:null,environmentProviderInstanceKey:null,environmentProviderSelection:null,
      lifecycle:{phase:'active',retireAt:null,teardown:null},mergeBaseBranch:null,name:null,updatedAt:0,workspaceProvisionType:'managed-worktree'})}},
    experimental_callHostRpc:async({method,input})=>{
      if(method==='identity')return {valid:true};
      if(method==='inspect')return {head,tree,files:['parser.ts']};
      const check=(input as {check:{name:string;argv:string[]}}).check;
      return {name:check.name,candidate:head,tree,argvDigest:digest(check.argv),exitCode:0,outputDigest:digest('ok'),isolation:'bwrap-unshare-all'};
    },
  });plugin(bb);
  const call=async(input:unknown)=>JSON.parse((await harness.behavior.callRpc('command',input) as {json:string}).json);
  let run=await call({op:'start',brief});assert.equal(run.stage,'Implement');
  run=await call({op:'reconcile',id:run.id});assert.equal(run.stage,'Critic');
  output=JSON.stringify({candidate:head,tree,scopeDigest:run.scopeDigest,evidenceDigest:digest(run.checks),outcome:'accept',findings:[],scopeAssessment:'Within scope'});
  run=await call({op:'reconcile',id:run.id});assert.equal(run.stage,'Publish');assert.match(run.reason,/Manual publication/);
  assert.equal(harness.inspection.sdk.callsTo('threads.spawn').length,2);
  const replacement=await harness.lifecycle.reload(plugin);
  const restored=JSON.parse((await replacement.harness.behavior.callRpc('command',{op:'get',id:run.id}) as {json:string}).json);
  assert.deepEqual(restored,run);await replacement.harness.lifecycle.dispose();
});
