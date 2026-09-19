// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectWorker } from '../browser.mjs';
import catalog from '../upstream-tools.json' with {type:'json'};
const config=endpoint=>({endpoint,token:'fixture-only',timeoutMs:3000});
async function mockWorker(t, {version=catalog.server.version, mismatch=false, redirect=false, drop=false}={}) {
 const sessions=new Map();const effects=[];
 const http=createServer(async(req,res)=>{
  if(redirect){res.writeHead(307,{location:'http://127.0.0.1:1/leak'}).end();return;}
  const sid=req.headers['mcp-session-id'];
  if(sid){
   const session=sessions.get(sid);if(!session){res.writeHead(404).end();return;}
   if(drop && req.method==='POST') {
    let body='';for await(const chunk of req)body+=chunk;
    if(JSON.parse(body).method==='tools/call'){effects.push('unknown');req.socket.destroy();return;}
    await session.transport.handleRequest(req,res,JSON.parse(body));return;
   }
   await session.transport.handleRequest(req,res);return;
  }
  const server=new Server({name:'fixture',version},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:Object.entries(catalog.tools).map(([name,tool])=>({name,...tool,inputSchema:mismatch?{type:'object',properties:{}}:tool.inputSchema}))}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{effects.push(request.params.name);return {content:[{type:'text',text:'fixture'}]};});
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,onsessioninitialized:id=>sessions.set(id,{server,transport})});
  await server.connect(transport);await transport.handleRequest(req,res);
 });
 http.listen(0,'127.0.0.1');await once(http,'listening');
 t.after(async()=>{await Promise.all([...sessions.values()].map(s=>s.server.close()));http.closeAllConnections();await new Promise(resolve=>http.close(resolve));});
 return {endpoint:`http://127.0.0.1:${http.address().port}/mcp`,effects,sessions};
}
test('real HTTP MCP transport initializes separate sessions and terminates them',async t=>{
 const fixture=await mockWorker(t);const a=await connectWorker(config(fixture.endpoint),new AbortController().signal);const b=await connectWorker(config(fixture.endpoint),new AbortController().signal);
 assert.equal(fixture.sessions.size,2);assert.match(JSON.stringify(await a.call('browser_snapshot',{},new AbortController().signal)),/fixture/);await a.close();await b.close();
});
for(const options of [{version:'wrong'},{mismatch:true},{redirect:true}])test(`rejects worker contract ${JSON.stringify(options)}`,async t=>{
 const fixture=await mockWorker(t,options);await assert.rejects(connectWorker(config(fixture.endpoint),new AbortController().signal));assert.equal(fixture.effects.length,0);
});
test('dropped mutation response does not cause transport replay',async t=>{
 const fixture=await mockWorker(t,{drop:true});const worker=await connectWorker(config(fixture.endpoint),new AbortController().signal);
 await assert.rejects(worker.call('browser_click',{target:'button'},new AbortController().signal));assert.deepEqual(fixture.effects,['unknown']);await worker.close();
});
test('pinned upstream HTTP server handshake and schemas (no browser launched)',async t=>{
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const child=spawn(process.execPath,['node_modules/@playwright/mcp/cli.js','--host','127.0.0.1','--port',String(port),'--isolated','--headless','--no-webmcp'],{stdio:['ignore','pipe','pipe']});
 t.after(async()=>{child.kill('SIGTERM');await once(child,'exit');});
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Upstream did not start')),5000);
  const ready=chunk=>{if(String(chunk).includes('Listening on')){clearTimeout(timer);resolve();}};
  child.stdout.on('data',ready);child.stderr.on('data',ready);child.once('exit',()=>{clearTimeout(timer);reject(Error('Upstream exited'));});
 });
 const worker=await connectWorker(config(`http://localhost:${port}/mcp`),new AbortController().signal);
 await worker.close();
});

test('lost server session does not reconnect or replay a call',async t=>{
 const fixture=await mockWorker(t);const worker=await connectWorker(config(fixture.endpoint),new AbortController().signal);
 const prior=[...fixture.sessions.values()];fixture.sessions.clear();
 await assert.rejects(worker.call('browser_click',{target:'button'},new AbortController().signal));
 assert.equal(fixture.sessions.size,0);assert.deepEqual(fixture.effects,[]);
 await worker.close();await Promise.all(prior.map(session=>session.server.close()));
});
