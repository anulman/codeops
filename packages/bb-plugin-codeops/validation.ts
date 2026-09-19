// SPDX-License-Identifier: Apache-2.0
// Trusted server only. Never import this module from the host entry or app.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { briefSchema, candidateSchema, digest, type Check, type ValidationRequest, type ValidationRunner } from './core/model.ts';
const exec = promisify(execFile);
const dns = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const configSchema = z.object({
  namespace:dns, kubeconfig:z.string().startsWith('/'), kubectl:z.string().startsWith('/'),
  // This catalog is an operator attestation of image contents, NOT worker input.
  candidates:z.array(z.object({repository:briefSchema.shape.repository,base:briefSchema.shape.base,
    candidate:candidateSchema,image:z.string().regex(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/)}).strict()).min(1),
}).strict();
type Config = z.infer<typeof configSchema>;
export type Transport = (args:string[], manifest?:unknown)=>Promise<string>;
export function kubectlTransport(config:Config):Transport {
  return async(args,manifest)=>{
    const directory=await mkdtemp(join(tmpdir(),'codeops-launch-'));
    try {
      const argv=['--kubeconfig',config.kubeconfig,'--namespace',config.namespace,'--request-timeout=15s',...args];
      if(manifest) {const path=join(directory,'job.json');await writeFile(path,JSON.stringify(manifest),{mode:0o600});argv.push('-f',path);}
      // Credentials remain in the trusted server's kubeconfig. No inherited plugin or model env.
      const result=await exec(config.kubectl,argv,{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},timeout:20000,maxBuffer:1024*1024});
      return result.stdout;
    } catch {throw new Error('Validation API operation unavailable; inspect exact Job before retry');}
    finally {await rm(directory,{recursive:true,force:true});}
  };
}
export function jobFor(config:Config, request:ValidationRequest) {
  const approved=config.candidates.filter(c=>c.repository===request.repository&&c.base===request.base&&digest(c.candidate)===digest(request.candidate));
  if(approved.length!==1) throw new Error('Exactly one operator-attested candidate image required');
  const image=approved[0]!.image, requestDigest=digest(request), name=`codeops-${requestDigest.slice(0,48)}`;
  const securityContext={allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}};
  return {apiVersion:'batch/v1',kind:'Job',metadata:{name,namespace:config.namespace,annotations:{'codeops/request':requestDigest}},
    spec:{backoffLimit:0,activeDeadlineSeconds:120,ttlSecondsAfterFinished:86400,parallelism:1,completions:1,
      template:{metadata:{annotations:{'codeops/request':requestDigest}},spec:{restartPolicy:'Never',serviceAccountName:'codeops-validation',
        automountServiceAccountToken:false,enableServiceLinks:false,hostNetwork:false,hostPID:false,hostIPC:false,
        securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,seccompProfile:{type:'RuntimeDefault'}},
        containers:[{name:'check',image,imagePullPolicy:'IfNotPresent',command:request.check.argv,workingDir:'/candidate',
          env:[{name:'HOME',value:'/tmp'},{name:'TMPDIR',value:'/tmp'}],securityContext,
          resources:{requests:{cpu:'100m',memory:'128Mi','ephemeral-storage':'128Mi'},limits:{cpu:'2',memory:'2Gi','ephemeral-storage':'1Gi'}},
          volumeMounts:[{name:'scratch',mountPath:'/tmp'}]}],volumes:[{name:'scratch',emptyDir:{sizeLimit:'1Gi'}}]}}}};
}
// Kubernetes defaults are allowed; all requested values must survive admission.
function contains(actual:unknown, expected:unknown):boolean {
  if(Array.isArray(expected)) return Array.isArray(actual)&&actual.length===expected.length&&expected.every((v,i)=>contains(actual[i],v));
  if(expected&&typeof expected==='object') return !!actual&&typeof actual==='object'&&Object.entries(expected).every(([k,v])=>contains((actual as Record<string,unknown>)[k],v));
  return actual===expected;
}
// Kubernetes omits these three false PodSpec fields on API serialization.
// Do not default any other security field, and do not coerce null or true.
function normalizeHostNamespaces(spec:any) {
  if(!spec||typeof spec!=='object') return spec;
  return {hostNetwork:false,hostPID:false,hostIPC:false,...spec};
}
// AlwaysPullImages admission can strengthen the template/Pod pull policy.
// Normalize only a stronger policy on the SAME immutable expected image.
function normalizePodSpec(actual:any,expected:any) {
  const spec=normalizeHostNamespaces(actual);
  if(!Array.isArray(spec?.containers)||!Array.isArray(expected?.containers)) return spec;
  return {...spec,containers:spec.containers.map((container:any,index:number)=>{
    const required=expected.containers[index];
    return required?.imagePullPolicy==='IfNotPresent'&&container.imagePullPolicy==='Always'&&
      container.image===required.image&&/@sha256:[a-f0-9]{64}$/.test(required.image)
      ?{...container,imagePullPolicy:'IfNotPresent'}:container;
  })};
}
function containsJobSpec(actual:any,expected:any):boolean {
  if(!actual?.template?.spec) return false;
  return contains({...actual,template:{...actual.template,spec:normalizePodSpec(actual.template.spec,expected.template.spec)}},expected);
}
function verifyPodSpec(actual:any, expected:any) {
  if(!contains(normalizePodSpec(actual,expected),expected)||actual.initContainers?.length||actual.ephemeralContainers?.length||actual.imagePullSecrets?.length||actual.hostAliases?.length||actual.shareProcessNamespace) throw new Error('Validation Pod isolation drift');
  for(const c of actual.containers??[]) if(c.envFrom?.length||c.lifecycle||c.livenessProbe||c.readinessProbe||c.startupProbe||c.securityContext?.privileged||c.securityContext?.capabilities?.add?.length||c.args?.length) throw new Error('Validation container drift');
}
export class KubernetesRunner implements ValidationRunner {
  readonly backend='kubernetes-job' as const;
  private config:Config;
  private transport:Transport;
  private pause:()=>Promise<unknown>;
  constructor(config:Config,transport:Transport=kubectlTransport(config),pause:()=>Promise<unknown>=()=>setTimeout(1000)) {
    this.config=config;this.transport=transport;this.pause=pause;
  }
  async check(request:ValidationRequest):Promise<Check> {
    const config=configSchema.parse(this.config),job=jobFor(config,request),name=job.metadata.name;
    const policies=JSON.parse(await this.transport(['get','networkpolicies','-o','json']));
    // Network policies are additive. Reject any other policy, even one granting only DNS.
    if(policies.items?.length!==1) throw new Error('Exclusive default-deny policy required');
    const policy=policies.items[0].spec;
    if(digest(policy.podSelector)!==digest({})||policy.ingress?.length||policy.egress?.length||
      digest([...(policy.policyTypes??[])].sort())!==digest(['Egress','Ingress'])) throw new Error('Default-deny network capability missing');
    // A name collision or uncertain create never triggers deletion/recreation or a retry.
    const created=JSON.parse(await this.transport(['create','-o','json'],job));
    if(!created.metadata?.uid||!contains(created.metadata,job.metadata)||!containsJobSpec(created.spec,job.spec)) throw new Error('Job creation identity mismatch');
    const uid=created.metadata.uid;
    const deadline=Date.now()+180000;
    for(let i=0;i<150 && Date.now()<deadline;i++) {
      const live=JSON.parse(await this.transport(['get','job',name,'-o','json']));
      if(live.metadata?.uid!==uid||!contains(live.metadata,job.metadata)||!containsJobSpec(live.spec,job.spec)) throw new Error('Job identity drift');
      verifyPodSpec(live.spec.template.spec,job.spec.template.spec);
      const pods=JSON.parse(await this.transport(['get','pods','-l',`batch.kubernetes.io/controller-uid=${uid}`,'-o','json'])).items;
      if(!Array.isArray(pods)||pods.length>1) throw new Error('Ambiguous validation Pods');
      const pod=pods[0];
      if(pod) {
        if(!pod.metadata?.uid||pod.metadata.namespace!==config.namespace||!pod.metadata.ownerReferences?.some((o:any)=>o.uid===uid&&o.kind==='Job'&&o.controller===true)) throw new Error('Pod owner drift');
        verifyPodSpec(pod.spec,job.spec.template.spec);
        const states=pod.status?.containerStatuses;
        const state=states?.[0],ended=state?.state?.terminated;
        if(ended) {
          const terminal=live.status?.conditions?.filter((c:any)=>['Complete','Failed'].includes(c.type)&&c.status==='True')??[];
          if(terminal.length===0) {await this.pause();continue;}
          if(terminal.length!==1||terminal[0].type!==(ended.exitCode===0?'Complete':'Failed')||pod.status.phase!==(ended.exitCode===0?'Succeeded':'Failed')) throw new Error('Inconsistent terminal Job evidence');
          if(states.length!==1||state.name!=='check'||state.restartCount!==0||!state.imageID?.endsWith(job.spec.template.spec.containers[0]!.image.split('@')[1])||
            !Number.isInteger(ended.exitCode)||!ended.finishedAt||!['Succeeded','Failed'].includes(pod.status.phase)||
            !live.status?.conditions?.some((c:any)=>['Complete','Failed'].includes(c.type)&&c.status==='True')) throw new Error('Terminal Job evidence missing');
          const output=await this.transport(['logs',pod.metadata.name,'-c','check','--limit-bytes=1048576']);
          const after=JSON.parse(await this.transport(['get','pods','-l',`batch.kubernetes.io/controller-uid=${uid}`,'-o','json'])).items;
          if(after?.length!==1||after[0].metadata?.uid!==pod.metadata.uid||digest(after[0].status?.containerStatuses)!==digest(states)) throw new Error('Pod changed during log readback');
          return {name:request.check.name,candidate:request.candidate.head,tree:request.candidate.tree,argvDigest:digest(request.check.argv),exitCode:ended.exitCode,outputDigest:digest(output),
            isolation:{backend:this.backend,version:1,requestDigest:digest(request),namespace:config.namespace,jobName:name,jobUid:uid,podUid:pod.metadata.uid,
              image:job.spec.template.spec.containers[0]!.image,runId:request.runId,generation:request.generation,lease:request.lease,repository:request.repository,base:request.base}};
        }
      }
      await this.pause();
    }
    throw new Error('Job outcome unknown; inspect termination before retry');
  }
}
export async function configuredRunner():Promise<ValidationRunner> {
  const path=process.env.CODEOPS_VALIDATION_CONFIG;
  if(!path?.startsWith('/')) throw new Error('Trusted server validation configuration unavailable');
  return new KubernetesRunner(configSchema.parse(JSON.parse(await readFile(path,'utf8'))));
}
