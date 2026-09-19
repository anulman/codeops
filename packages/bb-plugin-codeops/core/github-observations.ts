// SPDX-License-Identifier: Apache-2.0
/** Provider observations never grant publication, merge, release or deployment authority. */
export type Observation<T> = {authority:false; status:'known'; observedAt:string; value:T} |
  {authority:false; status:'unknown'|'stale'; observedAt:string|null; reason:string};
export interface GithubReader { get(repository:string,path:string):Promise<unknown>; }
export function freshness<T>(observation:Observation<T>, now=Date.now(), maxAgeMs=60_000):Observation<T> {
  if(observation.status!=='known') return observation;
  const at=Date.parse(observation.observedAt);
  return !Number.isFinite(at)||at>now||now-at>maxAgeMs
    ? {authority:false,status:'stale',observedAt:observation.observedAt,reason:'Refresh provider readback'} : observation;
}
export async function observe<T>(read:()=>Promise<T>):Promise<Observation<T>> {
  try {return {authority:false,status:'known',observedAt:new Date().toISOString(),value:await read()};}
  catch {return {authority:false,status:'unknown',observedAt:null,reason:'Provider read unavailable'};}
}

/** Each category fails independently; empty/missing checks never imply success. */
export async function observeMilestones(reader:GithubReader, repository:string, number:number, head:string) {
 const { z }=await import('zod');
 const deadline=Date.now()+45_000;let remaining=40;
 const read=async(repository:string,path:string)=>{if(Date.now()>deadline||remaining--<=0) throw Error('Observation budget exhausted');return reader.get(repository,path);};
 const checks=await observe(async()=>{
  const value=z.object({total_count:z.number().int(),check_runs:z.array(z.object({name:z.string(),head_sha:z.literal(head),status:z.string(),conclusion:z.string().nullable(),html_url:z.string().nullable()}))}).parse(await read(repository,`/commits/${head}/check-runs?per_page=100`));
  if(value.total_count!==value.check_runs.length) throw Error('Check inventory truncated');
  const statuses=z.object({total_count:z.number().int(),sha:z.literal(head),state:z.string(),statuses:z.array(z.object({context:z.string(),state:z.string(),target_url:z.string().nullable()}))}).parse(await read(repository,`/commits/${head}/status?per_page=100`));
  if(statuses.total_count!==statuses.statuses.length) throw Error('Status inventory truncated');
  return {checks:value.check_runs,statuses:statuses.statuses,requiredChecks:'unknown' as const};
 });
 const merge=await observe(async()=>{
  const pr=z.object({number:z.literal(number),head:z.object({sha:z.literal(head)}),state:z.string(),merged:z.boolean(),merged_at:z.string().nullable(),merge_commit_sha:z.string().nullable(),html_url:z.string()}).parse(await read(repository,`/pulls/${number}`));
  return {state:pr.state,merged:pr.merged,mergedAt:pr.merged_at,mergeCommit:pr.merge_commit_sha,url:pr.html_url};
 });
 const releases=await observe(async()=>{
  const list=z.array(z.object({id:z.number(),tag_name:z.string(),draft:z.boolean(),prerelease:z.boolean(),html_url:z.string()})).parse(await read(repository,'/releases?per_page=100'));
  if(list.length===100) throw Error('Release inventory truncated');
  // target_commitish is not an immutable commit. Resolve tags through GitHub objects.
  const matching=[];
  for(const release of list) {
   let object=z.object({object:z.object({type:z.string(),sha:z.string()})}).parse(await read(repository,`/git/ref/tags/${encodeURIComponent(release.tag_name)}`)).object;
   for(let depth=0;object.type==='tag'&&depth<5;depth++) object=z.object({object:z.object({type:z.string(),sha:z.string()})}).parse(await read(repository,`/git/tags/${object.sha}`)).object;
   if(object.type!=='commit') throw Error('Release tag unresolved');
   if(object.sha===head) matching.push({...release,commit:object.sha});
  }
  return {candidate:head,releases:matching};
 });
 const deployments=await observe(async()=>{
  const list=z.array(z.object({id:z.number().int().positive(),sha:z.literal(head),environment:z.string()})).parse(await read(repository,`/deployments?sha=${head}&per_page=20`));
  if(list.length===20) throw Error('Deployment inventory truncated');
  const results=[];
  for(const deployment of list) {
   const statuses=z.array(z.object({state:z.string(),created_at:z.string(),log_url:z.string().nullable()})).parse(await read(repository,`/deployments/${deployment.id}/statuses?per_page=1`));
   results.push({...deployment,latest:statuses[0]??null});
  }
  return results;
 });
 return {authority:false as const,repository,head,checks,merge,releases,deployments};
}
