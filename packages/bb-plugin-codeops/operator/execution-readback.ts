// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
// SDK 0.4.87 ThreadEventRow. Keep only native dispatch provenance, never text,
// tool output, provider environment events or writable plugin metadata.
const id=z.string().min(1),seq=z.number().int().nonnegative();
const row=z.object({id,threadId:id,seq,type:id});
const request=row.extend({type:z.literal('client/turn/requested'),data:z.object({
  direction:z.literal('outbound'),source:z.enum(['spawn','tell']),requestId:id,
  execution:z.object({permissionMode:z.enum(['accept-edits','auto','full'])}),
})});
const turnScope=z.object({kind:z.literal('turn'),turnId:id});
const accepted=row.extend({type:z.literal('turn/input/accepted'),scope:turnScope,data:z.object({clientRequestId:id})});
const completed=row.extend({type:z.literal('turn/completed'),scope:turnScope,data:z.object({status:z.enum(['completed','failed','interrupted'])})});
export async function readExecutionEvidence(threadId:string,expectedMode:'accept-edits'|'full',readPage:(afterSeq:number|undefined)=>Promise<unknown>) {
  const requests:z.infer<typeof request>[]=[],acceptances:z.infer<typeof accepted>[]=[],completions:z.infer<typeof completed>[]=[];
  let cursor:number|undefined;
  for(let page=0;page<100;page++) {
    const rows=z.array(row.passthrough()).max(100).parse(await readPage(cursor));
    for(const event of rows) {
      if(event.threadId!==threadId||(cursor!==undefined&&event.seq<=cursor)) throw new Error('Native event identity/order mismatch');
      cursor=event.seq;
      if(event.type==='client/turn/requested') requests.push(request.parse(event));
      if(event.type==='turn/input/accepted') acceptances.push(accepted.parse(event));
      if(event.type==='turn/completed') completions.push(completed.parse(event));
    }
    if(rows.length===100) continue;
    if(!requests.length||requests[0]!.data.source!=='spawn') throw new Error('Native spawn execution evidence missing');
    return requests.map(event=>{
      if(event.data.execution.permissionMode!==expectedMode) throw new Error('Native execution policy mismatch');
      const matches=acceptances.filter(a=>a.data.clientRequestId===event.data.requestId&&a.seq>event.seq);
      if(matches.length!==1) throw new Error('Native request acceptance missing or ambiguous');
      const acceptance=matches[0]!;
      const terminals=completions.filter(c=>c.scope.turnId===acceptance.scope.turnId&&c.seq>acceptance.seq);
      if(terminals.length!==1||terminals[0]!.data.status!=='completed') throw new Error('Native completed turn evidence missing or ambiguous');
      return {permissionMode:event.data.execution.permissionMode,requestId:event.data.requestId,turnId:acceptance.scope.turnId,
        requested:{id:event.id,seq:event.seq},accepted:{id:acceptance.id,seq:acceptance.seq},completed:{id:terminals[0]!.id,seq:terminals[0]!.seq}};
    });
  }
  throw new Error('Native event evidence exceeded bounded pagination');
}
