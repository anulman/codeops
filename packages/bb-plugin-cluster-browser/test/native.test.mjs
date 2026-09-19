// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFakePluginHost,makePluginAgentConfigurationContext,experimental_scanPublicSdkOnly} from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
const projects=JSON.stringify({isolation:'playwright-isolated',projects:{p:{preview:'https://app.example.test/'}}});
test('installed SDK registers native tools, selects project tools and refreshes settings',async()=>{
 const {bb,harness}=createFakePluginHost({pluginId:'cluster-browser',agentSkillIds:['cluster-browser'],settings:{projects,workerEndpoint:'https://runner.example.test/mcp'}});
 await plugin(bb);
 const context=makePluginAgentConfigurationContext({project:{id:'p'}});
 const resolve=()=>harness.behavior.resolveAgentConfiguration(context);
 const selected=await resolve();
 assert.equal(selected.tools.length,11);
 const denied=await harness.behavior.callAgentTool('cluster_browser_open',{target:'preview'},{threadId:'t',projectId:'unknown'});
 assert.equal(denied.isError,true);
 await harness.behavior.setSettings({projects:'{}'});await new Promise(resolve=>setImmediate(resolve));assert.equal((await resolve()).tools.length,0);
 await harness.behavior.setSettings({projects});await new Promise(resolve=>setImmediate(resolve));assert.equal((await resolve()).tools.length,11);
 await harness.lifecycle.dispose();
});
test('package uses public SDK imports',()=>{
 const result=experimental_scanPublicSdkOnly(new URL('..',import.meta.url).pathname,{allow:[/^@modelcontextprotocol\/sdk\//,/^@playwright\/mcp$/,/^ajv\//]});
 assert.deepEqual(result.violations,[]);assert.deepEqual(result.privateDependencies,[]);
});
