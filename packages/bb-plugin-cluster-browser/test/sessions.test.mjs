// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSessions, parseConfiguration } from '../browser.mjs';
const config = () => ({...parseConfiguration(JSON.stringify({isolation:'playwright-isolated',projects:{p:{preview:'https://app.example.test/'},q:{preview:'https://other.example.test/'}}}), 'https://runner.example.test/mcp', 'private-test-token'), timeoutMs: 200});
const ctx = (threadId = 'a', projectId = 'p', signal = new AbortController().signal) => ({threadId,projectId,signal});
const ok = value => ({content:[{type:'text',text:value}]});
function fixture(overrides = {}) {
 const workers=[];
 const manager = new BrowserSessions(config(), async () => {
   const worker = { calls:[], closed:0, async call(name,args,signal) { this.calls.push({name,args,signal}); return ok(`worker-${workers.indexOf(this)}`); }, async close(){this.closed++;}, ...overrides };
   workers.push(worker);return worker;
 });
 return {manager,workers};
}
test('thread and project contexts select distinct sessions; calls retain their session', async () => {
 const {manager,workers}=fixture();
 for (const context of [ctx(),ctx('b'),ctx('a','q')]) assert.equal((await manager.execute('open',{target:'preview'},context)).isError,false);
 assert.equal(workers.length,3);
 assert.match(JSON.stringify(await manager.execute('browser_snapshot',{},ctx())),/worker-0/);
 assert.match(JSON.stringify(await manager.execute('browser_snapshot',{},ctx('b'))),/worker-1/);
 await manager.execute('browser_close',{},ctx());
 assert.equal(workers[0].closed,1);assert.equal(workers[1].closed,0);
 await manager.dispose();
});
test('missing owner, spoofed owner, invalid target and runner filesystem arguments fail before effects', async () => {
 const {manager,workers}=fixture();
 for (const [name,args,context] of [['open',{target:'preview'},ctx('')],['open',{target:'preview'},ctx('a','unknown')],['open',{target:'unknown'},ctx()],['open',{target:'preview',threadId:'b'},ctx()],['browser_snapshot',{filename:'/tmp/file'},ctx()]]) assert.equal((await manager.execute(name,args,context)).isError,true);
 assert.equal(workers.length,0);
});
test('configuration rejects credential-bearing URLs and unacknowledged isolation', () => {
 for (const endpoint of ['file:///tmp/a','https://user:pass@runner.example.test/mcp','https://runner.example.test/mcp?secret=a','http://runner.example.test/mcp']) assert.throws(()=>parseConfiguration('{"isolation":"playwright-isolated","projects":{}}',endpoint));
 assert.throws(()=>parseConfiguration('{}','https://runner.example.test/mcp'));
});
test('unknown mutation outcome retires session without replay; reopen is explicit', async () => {
 const {manager,workers}=fixture();await manager.execute('open',{target:'preview'},ctx());
 workers[0].call=async function(name){this.calls.push({name});throw Error('private-test-token https://runner.example.test/mcp');};
 const result=await manager.execute('browser_click',{target:'button'},ctx());
 assert.match(JSON.stringify(result),/result unknown/);assert.doesNotMatch(JSON.stringify(result),/private-test-token|runner.example/);
 assert.equal(workers[0].calls.filter(c=>c.name==='browser_click').length,1);
 assert.equal((await manager.execute('browser_snapshot',{},ctx())).isError,true);
 assert.equal(workers.length,1);await manager.dispose();
});
test('unavailable worker returns a bounded error without transport details',async()=>{
 const manager=new BrowserSessions(config(),async()=>{throw Error('private-test-token');});
 const result=await manager.execute('open',{target:'preview'},ctx());assert.equal(result.isError,true);assert.doesNotMatch(JSON.stringify(result),/private-test-token/);assert.equal(manager.sessions.size,0);
});
test('cancellation aborts call, retires session and does not replay',async()=>{
 const {manager,workers}=fixture();await manager.execute('open',{target:'preview'},ctx());
 workers[0].call=async(name,args,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 const abort=new AbortController();const call=manager.execute('browser_wait_for',{text:'never'},ctx('a','p',abort.signal));
 await new Promise(resolve=>setImmediate(resolve));abort.abort();
 assert.equal((await call).isError,true);assert.equal(manager.sessions.size,0);assert.equal(workers[0].closed,1);
});
test('idle expiry and absolute lifetime release sessions',async()=>{
 const {manager,workers}=fixture();let now=0;manager.now=()=>now;
 await manager.execute('open',{target:'preview'},ctx());now=manager.config.idleMs;await manager.sweep();assert.equal(workers[0].closed,1);
 await manager.execute('open',{target:'preview'},ctx());now+=manager.config.maxMs;await manager.sweep();assert.equal(workers[1].closed,1);
});
test('concurrent same-owner calls are rejected while other owners remain usable',async()=>{
 const {manager,workers}=fixture();await manager.execute('open',{target:'preview'},ctx());
 let finish;workers[0].call=()=>new Promise(resolve=>{finish=resolve;});
 const call=manager.execute('browser_snapshot',{},ctx());await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await manager.execute('browser_click',{target:'button'},ctx())).isError,true);
 assert.equal((await manager.execute('open',{target:'preview'},ctx('b'))).isError,false);
 finish(ok('done'));await call;await manager.dispose();
});
test('native image parts survive; known transport secrets are redacted; output is bounded',async()=>{
 const {manager,workers}=fixture();await manager.execute('open',{target:'preview',run:'test-run',candidate:'abc123'},ctx());
 workers[0].call=async()=>({content:[{type:'text',text:'private-test-token https://runner.example.test/mcp '+'x'.repeat(30000)},{type:'image',mimeType:'image/png',data:'aGVsbG8='}]});
 const result=await manager.execute('browser_take_screenshot',{scale:'css'},ctx());
 assert.equal(result.content[2].type,'image');assert.equal(result.content[2].data,'aGVsbG8=');assert.match(result.content[0].text,/abc123/);assert.doesNotMatch(JSON.stringify(result),/private-test-token|runner.example/);assert.ok(JSON.stringify(result).length<25000);
 await manager.dispose();
});
test('invalid navigation does not destroy a valid session',async()=>{
 const {manager}=fixture();await manager.execute('open',{target:'preview'},ctx());
 assert.equal((await manager.execute('browser_navigate',{url:'file:///etc/passwd'},ctx())).isError,true);
 assert.equal((await manager.execute('browser_snapshot',{},ctx())).isError,false);await manager.dispose();
});

test('unconfirmed DELETE is reported instead of claiming remote closure',async()=>{
 const {manager,workers}=fixture();await manager.execute('open',{target:'preview'},ctx());
 workers[0].close=async()=>false;
 const result=await manager.execute('browser_close',{},ctx());assert.equal(result.isError,true);assert.match(JSON.stringify(result),/Remote cleanup is unconfirmed/);assert.equal(manager.sessions.size,0);
});

test('open follows successful navigation with inline snapshot on the same worker',async()=>{
 const {manager,workers}=fixture({async call(name,args){
  this.calls.push({name,args});
  return ok(name==='browser_snapshot' ? '- heading "Actual inline DOM"' : '### Snapshot\n- [Snapshot](.playwright-mcp/page.yml)');
 }});
 const result=await manager.execute('open',{target:'preview'},ctx());
 assert.equal(result.isError,false);assert.match(result.content[1].text,/Actual inline DOM/);
 assert.doesNotMatch(result.content[1].text,/page.yml/);
 assert.deepEqual(workers[0].calls,[{name:'browser_navigate',args:{url:'https://app.example.test/'}},{name:'browser_snapshot',args:{}}]);
 assert.match(JSON.stringify(await manager.execute('browser_snapshot',{},ctx())),/Actual inline DOM/);
 assert.equal(workers[0].calls.length,3);await manager.dispose();
});

test('failed navigation is returned without a follow-up snapshot',async()=>{
 const error={...ok('Navigation failed'),isError:true};
 const {manager,workers}=fixture({async call(name){this.calls.push({name});return error;}});
 const result=await manager.execute('open',{target:'preview'},ctx());
 assert.equal(result.isError,true);assert.match(JSON.stringify(result),/Navigation failed/);
 assert.deepEqual(workers[0].calls,[{name:'browser_navigate'}]);await manager.dispose();
});

test('initial snapshot failure and cancellation preserve errors without replaying navigation',async()=>{
 for (const failure of ['error','disconnect','cancel']) {
  const abort=new AbortController();
  const {manager,workers}=fixture({async call(name){
   this.calls.push({name});
   if(name==='browser_snapshot') {
    if(failure==='disconnect') throw Error('private-test-token');
    if(failure==='cancel') abort.abort();
    return {...ok('Snapshot failed'),isError:true};
   }
   return ok('Navigation completed');
  }});
  const result=await manager.execute('open',{target:'preview'},ctx('a','p',abort.signal));
  assert.equal(result.isError,true);assert.doesNotMatch(JSON.stringify(result),/private-test-token/);
  assert.deepEqual(workers[0].calls.map(c=>c.name),['browser_navigate','browser_snapshot']);
  if(failure==='error') assert.match(JSON.stringify(result),/Snapshot failed/);
  else {assert.match(JSON.stringify(result),/No retry was made/);assert.equal(manager.sessions.size,0);}
  await manager.dispose();
 }
});
