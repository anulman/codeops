// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BrowserSessions, parseConfiguration } from '../browser.mjs';
import { qualificationProfile } from './qualification-profile.mjs';
const endpoint=process.env.CLUSTER_BROWSER_FIXTURE_ENDPOINT;
const target=process.env.CLUSTER_BROWSER_FIXTURE_TARGET;
if (!endpoint || !target) {
 console.error('Missing operator fixture: set CLUSTER_BROWSER_FIXTURE_ENDPOINT and CLUSTER_BROWSER_FIXTURE_TARGET. Chromium must run in the separate disposable runner.');
 process.exit(2);
}
let isolation;
try { isolation=qualificationProfile(process.env); }
catch (error) { console.error(error.message); process.exit(2); }
await rm('.output/browser-qualification/result.json',{force:true});
const config=parseConfiguration(JSON.stringify({isolation:'playwright-isolated',projects:{fixture:{preview:target}}}),endpoint,process.env.CLUSTER_BROWSER_FIXTURE_TOKEN);
const sessions=new BrowserSessions(config);
let phase='open fixture';
const context=threadId=>({threadId,projectId:'fixture',signal:new AbortController().signal});
const call=async(name,args,owner)=>{
 phase=name;
 const result=await sessions.execute(name,args,context(owner));
 assert.equal(result.isError,false,`${name} failed (details withheld)`);return result;
};
const stringify=result=>JSON.stringify(result.content.filter(p=>p.type==='text'));
try {
 const first=await call('open',{target:'preview',run:'disposable-browser-qualification'},'a');
 assert.match(stringify(first),/CLUSTER_BROWSER_DISPOSABLE_FIXTURE/);
 await call('browser_fill_form',{fields:[{target:'#value',name:'Value',type:'textbox',value:'owner-a-value'}]},'a');
 await call('browser_click',{target:'#save'},'a');
 await call('browser_navigate',{url:target},'a');
 assert.match(stringify(await call('browser_snapshot',{},'a')),/owner-a-value/);
 const second=await call('open',{target:'preview'},'b');
 assert.match(stringify(second),/Stored: empty/);assert.match(stringify(second),/Cookie: empty/);assert.doesNotMatch(stringify(second),/owner-a-value/);
 await call('browser_fill_form',{fields:[{target:'#value',name:'Value',type:'textbox',value:'owner-b-value'}]},'b');
 await call('browser_click',{target:'#save'},'b');
 const a=stringify(await call('browser_snapshot',{},'a'));assert.match(a,/owner-a-value/);assert.doesNotMatch(a,/owner-b-value/);
 await call('browser_press_key',{key:'Tab'},'a');
 await call('browser_wait_for',{text:'owner-a-value'},'a');
 assert.match(stringify(await call('browser_console_messages',{level:'error'},'a')),/fixture diagnostic/);
 assert.match(stringify(await call('browser_network_requests',{static:false},'a')),/fixture-failure/);
 const shot=await call('browser_take_screenshot',{scale:'css',type:'png'},'a');
 const image=shot.content.find(p=>p.type==='image');assert.ok(image,'No native image result');
 const bytes=Buffer.from(image.data,'base64');assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 await call('browser_close',{},'a');assert.match(stringify(await call('browser_snapshot',{},'b')),/owner-b-value/);
 assert.match(stringify(await call('open',{target:'preview'},'a')),/Stored: empty/);
 await mkdir('.output/browser-qualification',{recursive:true});
 await writeFile('.output/browser-qualification/screenshot.png',bytes);
 await writeFile('.output/browser-qualification/result.json',JSON.stringify({passed:true,isolation,time:new Date().toISOString(),candidateFiles:Object.fromEntries(await Promise.all(['browser.mjs','server.ts','upstream-tools.json','scripts/qualify-browser.mjs','scripts/qualification-profile.mjs'].map(async file=>[file,createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex')]))),mcp:'0.0.82',playwright:'1.64.0-alpha-1789764292000',screenshotSha256:createHash('sha256').update(bytes).digest('hex'),checks:['two-owner DOM/cookie/localStorage isolation','context retained across calls','fill/click/navigate/press/wait','console/network diagnostics','native PNG delivery','close does not affect peer','reopen clears state']},null,2)+'\n');
 console.log('Disposable browser qualification passed; artifacts in .output/browser-qualification.');
} catch {
 console.error(`Disposable browser qualification failed during ${phase}. No qualification receipt was created. Inspect the isolated runner locally; do not publish its endpoint or credentials.`);
 process.exitCode=1;
} finally {await sessions.dispose();}
