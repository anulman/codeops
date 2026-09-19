// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, jobFor, KubernetesRunner, type Transport } from '../validation.ts';
import { checkSchema, digest, type ValidationRequest } from '../core/model.ts';
const request:ValidationRequest={runId:'run',generation:1,lease:'lease',repository:'https://github.com/example/repo',base:'a'.repeat(40),
  candidate:{head:'b'.repeat(40),tree:'c'.repeat(40),files:['test.js']},check:{name:'unit',argv:['node','--test']}};
const config=configSchema.parse({namespace:'codeops-validation',kubeconfig:'/operator/kubeconfig',kubectl:'/usr/bin/kubectl',
  candidates:[{repository:request.repository,base:request.base,candidate:request.candidate,image:`registry.example/validation@sha256:${'d'.repeat(64)}`} ]});
function fixture(change?:(job:any,pod:any,policies:any)=>void) {
  const job:any=structuredClone(jobFor(config,request));job.metadata.uid='job-uid';job.status={conditions:[{type:'Complete',status:'True'}]};
  const pod:any={metadata:{name:'pod',namespace:config.namespace,uid:'pod-uid',ownerReferences:[{uid:'job-uid',kind:'Job',controller:true}]},spec:structuredClone(job.spec.template.spec),
    status:{phase:'Succeeded',containerStatuses:[{name:'check',restartCount:0,imageID:config.candidates[0]!.image,state:{terminated:{exitCode:0,finishedAt:'2026-09-19T00:00:00Z'}}}]}};
  const policies={items:[{spec:{podSelector:{},policyTypes:['Ingress','Egress'],ingress:[],egress:[]}}]};
  change?.(job,pod,policies);const calls:string[][]=[];
  const transport:Transport=async(args,manifest)=>{calls.push(args);
    if(args[0]==='create') return JSON.stringify({...manifest as object,metadata:{...job.metadata}});
    if(args[1]==='networkpolicies')return JSON.stringify(policies);
    if(args[1]==='job')return JSON.stringify(job);
    if(args[1]==='pods')return JSON.stringify({items:[pod]});
    if(args[0]==='logs')return 'untrusted check output';
    throw new Error('Unexpected API');};
  return {transport,calls};
}
test('trusted API readback binds candidate, argv, run, lease and Kubernetes identities',async()=>{
  const {transport,calls}=fixture();const result=checkSchema.parse(await new KubernetesRunner(config,transport,async()=>{}).check(request));
  assert.equal(result.candidate,request.candidate.head);assert.equal(result.argvDigest,digest(request.check.argv));
  assert.equal(result.isolation.backend,'kubernetes-job');
  if(result.isolation.backend==='kubernetes-job') {assert.equal(result.isolation.jobUid,'job-uid');assert.equal(result.isolation.podUid,'pod-uid');assert.equal(result.isolation.requestDigest,digest(request));}
  assert.equal(calls.filter(c=>c[0]==='create').length,1);assert.ok(!JSON.stringify(jobFor(config,request)).includes('kubeconfig'));
});
for(const [name,change] of Object.entries({
  'Job UID':(j:any)=>{j.metadata.uid='different';},
  'candidate command':(j:any,p:any)=>{p.spec.containers[0].command=['true'];},
  'token mount':(j:any,p:any)=>{p.spec.automountServiceAccountToken=true;},
  'secret environment':(j:any,p:any)=>{p.spec.containers[0].envFrom=[{secretRef:{name:'secret'}}];},
  'sidecar':(j:any,p:any)=>{p.spec.containers.push(p.spec.containers[0]);},
  'volume':(j:any,p:any)=>{p.spec.volumes.push({name:'host',hostPath:{path:'/'}});},
  'owner UID':(j:any,p:any)=>{p.metadata.ownerReferences[0].uid='wrong';},
  'runtime image':(j:any,p:any)=>{p.status.containerStatuses[0].imageID='wrong';},
  'restart':(j:any,p:any)=>{p.status.containerStatuses[0].restartCount=1;},
  'additive egress policy':(j:any,p:any,n:any)=>{n.items.push(n.items[0]);},
})) test(`rejects ${name} drift`,async()=>{
  const {transport}=fixture(change);
  // Mutate only GET for UID: the creation UID is separately captured.
  const wrapped:Transport=async(args,manifest)=>{const result=await transport(args,manifest);if(name==='Job UID'&&args[0]==='create')return JSON.stringify({...JSON.parse(result),metadata:{...JSON.parse(result).metadata,uid:'job-uid'}});return result;};
  await assert.rejects(new KubernetesRunner(config,wrapped,async()=>{}).check(request));
});
test('missing candidate or mutable image fails before any Kubernetes effect',async()=>{
  assert.throws(()=>jobFor(config,{...request,candidate:{...request.candidate,head:'e'.repeat(40)}}),/attested/);
  assert.throws(()=>configSchema.parse({...config,candidates:[{...config.candidates[0],image:'node:24'}]}));
  assert.equal(checkSchema.safeParse({name:'unit',candidate:request.candidate.head,tree:request.candidate.tree,argvDigest:'x',exitCode:0,outputDigest:digest('ok'),isolation:{backend:'kubernetes-job',version:1}}).success,false);
});
test('ambiguous create is never retried or turned into test evidence',async()=>{
  let creates=0;const {transport}=fixture();
  await assert.rejects(new KubernetesRunner(config,async(args,manifest)=>{if(args[0]==='create'){creates++;throw new Error('lost response');}return transport(args,manifest);}).check(request));
  assert.equal(creates,1);
});

test('waits for Job controller completion after Pod termination',async()=>{
  const {transport}=fixture();let reads=0,pauses=0;
  const result=await new KubernetesRunner(config,async(args,manifest)=>{
    const value=await transport(args,manifest);
    if(args[1]==='job'&&reads++===0) {const job=JSON.parse(value);delete job.status;return JSON.stringify(job);}
    return value;
  },async()=>{pauses++;}).check(request);
  assert.equal(result.exitCode,0);assert.equal(pauses,1);
});
test('a failed Job cannot certify exit zero and a failed check remains failed',async()=>{
  const inconsistent=fixture((job)=>{job.status.conditions=[{type:'Failed',status:'True'}];});
  await assert.rejects(new KubernetesRunner(config,inconsistent.transport,async()=>{}).check(request),/Inconsistent/);
  const failed=fixture((job,pod)=>{job.status.conditions=[{type:'Failed',status:'True'}];pod.status.phase='Failed';pod.status.containerStatuses[0].state.terminated.exitCode=7;});
  assert.equal((await new KubernetesRunner(config,failed.transport,async()=>{}).check(request)).exitCode,7);
});
