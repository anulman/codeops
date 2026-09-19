// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from 'react';
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server.ts';
import type { Run } from './core/model.ts';
type Summary=Pick<Run,'id'|'revision'|'stage'|'condition'|'reason'>&{outcome:string;head:string|null};
function Panel() {
  const navigate=useBbNavigate();const rpc=useRpc<typeof rpcContract>();const [runs,setRuns]=useState<Summary[]>([]);const [detail,setDetail]=useState<Run|null>(null);const [error,setError]=useState('');
  const refresh=useCallback(()=>{rpc.call('command',{op:'list'}).then(r=>{setRuns(JSON.parse(r.json));setError('');},()=>setError('Cannot read CodeOps state. Retry when connected.'));},[rpc]);
  useEffect(refresh,[refresh]);useRealtime('changed',refresh);
  async function act(op:'get'|'reconcile'|'pause'|'resume'|'cancel',run:Summary) {
    try {const result=await rpc.call('command',op==='get'||op==='reconcile'?{op,id:run.id}:{op,id:run.id,revision:run.revision});setDetail(JSON.parse(result.json));refresh();}catch {setError('Action rejected. Refresh and check the current run revision.');}
  }
  return <main className="min-w-0 max-w-full p-4 space-y-4"><h1 className="text-xl font-semibold">CodeOps</h1>
    <p>Implementation → isolated checks → advisory review → manual publication. Merge, release and deployment require human decisions.</p>
    {error&&<p role="alert">{error}</p>}<button onClick={refresh}>Refresh</button>
    {runs.length===0&&<p>No runs. Use <code>bb codeops command</code> to admit a frozen brief.</p>}
    {runs.map(run=><article key={run.id} className="min-w-0 max-w-full rounded border border-border p-4 space-y-2"><h2 className="min-w-0 break-all font-semibold">{run.outcome}</h2>
      <p>{run.stage} · {run.condition}</p><p>{run.reason}</p><code className="block min-w-0 max-w-full break-all">{run.head??'No candidate'}</code>
      <div className="flex gap-3 flex-wrap">{(['get','reconcile','pause','resume','cancel'] as const).map(op=><button key={op} onClick={()=>act(op,run)}>{op==='get'?'Evidence':op}</button>)}</div>
    </article>)}
    {detail&&<section className="min-w-0 max-w-full"><h2>Run {detail.id}</h2><p className="min-w-0 max-w-full break-all">Policy {detail.policy}; scope {detail.scopeDigest}</p><div className="flex gap-3 flex-wrap"><button onClick={()=>navigate.toThread(detail.brief.parentThreadId)}>Controlling thread</button>{detail.actions.filter(a=>a.threadId).map(a=><button key={a.key} onClick={()=>navigate.toThread(a.threadId!)}>{a.kind} · attempt {a.generation}</button>)}</div><p>Review uses bb’s shared trust model. Human merge, release and deployment authority is never inferred from this report.</p><pre className="whitespace-pre-wrap break-all">{JSON.stringify({candidate:detail.candidate,checks:detail.checks,review:detail.review,decisions:detail.decisions,actions:detail.actions},null,2)}</pre></section>}
  </main>;
}
export default definePluginApp(app=>{app.slots.navPanel({id:'runs',title:'CodeOps',icon:'ListTodo',path:'runs',component:Panel});});
