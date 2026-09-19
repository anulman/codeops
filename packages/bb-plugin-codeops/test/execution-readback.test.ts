// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readExecutionEvidence } from '../operator/execution-readback.ts';
function events(mode='full') {
  return [
    {id:'request-event',threadId:'thread',seq:1,type:'client/turn/requested',scope:{kind:'thread'},data:{direction:'outbound',source:'spawn',requestId:'request',execution:{permissionMode:mode},input:[{text:'Not evidence; never persist'}]}},
    {id:'accepted-event',threadId:'thread',seq:2,type:'turn/input/accepted',scope:{kind:'turn',turnId:'turn'},data:{clientRequestId:'request'}},
    {id:'completed-event',threadId:'thread',seq:3,type:'turn/completed',scope:{kind:'turn',turnId:'turn'},data:{status:'completed'}},
  ];
}
test('native readback preserves resolved mode and exact provenance without transcript data',async()=>{
  const result=await readExecutionEvidence('thread','full',async()=>events());
  assert.deepEqual(result,[{permissionMode:'full',requestId:'request',turnId:'turn',requested:{id:'request-event',seq:1},accepted:{id:'accepted-event',seq:2},completed:{id:'completed-event',seq:3}}]);
  assert.equal(JSON.stringify(result).includes('Not evidence'),false);
  assert.equal((await readExecutionEvidence('thread','accept-edits',async()=>events('accept-edits')))[0]!.permissionMode,'accept-edits');
});
test('paginated capture follows native sequence cursor across acceptance and completion',async()=>{
  const [request,accepted,completed]=events();
  const first=[request,...Array.from({length:99},(_,i)=>({id:`ignored-${i}`,threadId:'thread',seq:i+2,type:'item/updated',data:{text:'ignored'}}))];
  const cursors:(number|undefined)[]=[];
  const result=await readExecutionEvidence('thread','full',async cursor=>{
    cursors.push(cursor);return cursor===undefined?first:[{...accepted,seq:101},{...completed,seq:102}];
  });
  assert.deepEqual(cursors,[undefined,100]);assert.equal(result[0]!.completed.seq,102);
});
for(const [name,change] of Object.entries({
  missing:(e:any[])=>e.filter(x=>x.type!=='client/turn/requested'),
  'missing mode':(e:any[])=>{delete e[0].data.execution.permissionMode;return e;},
  'wrong mode':()=>events('accept-edits'),
  'wrong thread':(e:any[])=>{e[1].threadId='other';return e;},
  'wrong request':(e:any[])=>{e[1].data.clientRequestId='other';return e;},
  'wrong turn':(e:any[])=>{e[2].scope.turnId='other';return e;},
  'thread scope':(e:any[])=>{e[1].scope={kind:'thread'};return e;},
  'wrong order':(e:any[])=>[e[1],e[0],e[2]],
  'no acceptance':(e:any[])=>[e[0],e[2]],
  'no completion':(e:any[])=>e.slice(0,2),
  'failed completion':(e:any[])=>{e[2].data.status='failed';return e;},
  'interrupted completion':(e:any[])=>{e[2].data.status='interrupted';return e;},
  'later mismatched mode':(e:any[])=>[...e,{...e[0],id:'second-request',seq:4,data:{...e[0].data,requestId:'second',execution:{permissionMode:'accept-edits'}}}],
  'duplicate acceptance':(e:any[])=>[e[0],e[1],{...e[1],id:'duplicate',seq:3},{...e[2],seq:4}],
  'prose is not policy':()=>[{id:'text',threadId:'thread',seq:1,type:'item/updated',data:{text:'permissionMode=full',pluginMetadata:{permissionMode:'full'}}}],
})) test(`native capture rejects ${name}`,async()=>{
  await assert.rejects(readExecutionEvidence('thread','full',async()=>change(events())));
});
test('bounded pagination cannot certify a truncated thread',async()=>{
  let calls=0;
  await assert.rejects(readExecutionEvidence('thread','full',async cursor=>{calls++;return Array.from({length:100},(_,i)=>({id:`event-${calls}-${i}`,threadId:'thread',seq:(cursor??0)+i+1,type:'item/updated'}));}),/bounded pagination/);
  assert.equal(calls,100);
});
