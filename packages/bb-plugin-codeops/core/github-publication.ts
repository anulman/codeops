// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { PublicationAdapter, PublicationPermit, PublishedPull } from './publication.ts';
const execute=promisify(execFile);
const pull=z.object({number:z.number().int().positive(),html_url:z.string().url(),state:z.enum(['open','closed']),title:z.string(),body:z.string().nullable(),head:z.object({sha:z.string(),ref:z.string(),repo:z.object({full_name:z.string()})}),base:z.object({sha:z.string(),ref:z.string(),repo:z.object({full_name:z.string()})})});
/** Real Git/gh adapter for a dedicated trusted publisher host. The object store
 * is operator-created bare Git data, never the worker checkout or its config. */
export class GithubPublication implements PublicationAdapter {
 constructor(private readonly repositories:ReadonlyMap<string,{directory:string;credentialVariable:string}>) {}
 private environment(repository:string,credential=false):NodeJS.ProcessEnv {
  const entry=this.repositories.get(repository);if(!entry) throw Error('Repository not admitted');
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:'/nonexistent',GH_CONFIG_DIR:'/nonexistent',GH_HOST:'github.com',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
  if(credential) {const token=process.env[entry.credentialVariable];if(!token) throw Error('Repository credential unavailable');env.GH_TOKEN=token;}
  return env;
 }
 private directory(repository:string):string {
  const directory=this.repositories.get(repository)?.directory;if(!directory||!directory.startsWith('/')) throw Error('Repository not admitted');return directory;
 }
 private async git(repository:string,args:string[],credential=false):Promise<string> {
  const directory=this.directory(repository);
  try {const result=await execute('git',['--no-replace-objects',`--git-dir=${directory}`,'-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','credential.helper=!gh auth git-credential',...args],{timeout:60_000,maxBuffer:2_000_000,env:this.environment(repository,credential)});return result.stdout.trim();}
  catch {throw Error('Git effect failed or unknown; inspect live readback');}
 }
 async get(repository:string,path:string):Promise<unknown> {
  if(!/^\/[A-Za-z0-9_/?=&.%+-]*$/.test(path)||path.includes('..')) throw Error('Invalid read path');
  return this.api(repository,path);
 }
 private async api(repository:string,path:string,method='GET',fields:Record<string,string|boolean>={}):Promise<unknown> {
  this.directory(repository);
  // No shell interpolation. Provider errors are deliberately not logged/returned.
  const args=['api','--hostname','github.com',`repos/${repository}${path}`,'--method',method];
  for(const [key,value] of Object.entries(fields)) args.push(typeof value==='boolean'?'-F':'-f',`${key}=${value}`);
  try {const result=await execute('gh',args,{timeout:30_000,maxBuffer:2_000_000,env:this.environment(repository,true)});return JSON.parse(result.stdout);}
  catch(error) {
   // Return only a status and a fixed known policy denial, never provider output.
   const stderr=typeof error==='object'&&error!==null&&'stderr' in error&&typeof error.stderr==='string'?error.stderr:'';
   const status=/HTTP (\d{3})/.exec(stderr)?.[1];
   const denied=stderr.includes('GitHub Actions is not permitted to create or approve pull requests');
   throw Error(`GitHub effect failed or unknown${status?` (HTTP ${status})`:''}${denied?'; repository Actions PR creation is disabled':''}; inspect live readback`);
  }
 }
 async prepareObjects(p:PublicationPermit,bundle:{data:string;sha256:string}):Promise<void> {
  const bytes=Buffer.from(bundle.data,'base64');
  if(bytes.length===0||bytes.length>16*1024*1024||bytes.toString('base64')!==bundle.data||createHash('sha256').update(bytes).digest('hex')!==bundle.sha256) throw Error('Invalid candidate bundle');
  if(await this.git(p.repository,['rev-parse','--is-bare-repository'])!=='true') throw Error('Trusted bare object store required');
  // Fetch only the admitted repository/base. Credentials never enter bundle ingestion.
  if(await this.head(p.repository,p.baseBranch)!==p.base) throw Error('Base drift');
  await this.git(p.repository,['fetch','--no-tags','--no-write-fetch-head',`https://github.com/${p.repository}.git`,p.base],true);
  await this.ingestBundle(p,bundle);
 }
 /** Credential-free object ingestion, also exercised directly by the offline fixture. */
 async ingestBundle(p:PublicationPermit,bundle:{data:string;sha256:string}):Promise<void> {
  const bytes=Buffer.from(bundle.data,'base64');
  if(bytes.length===0||bytes.length>16*1024*1024||bytes.toString('base64')!==bundle.data||createHash('sha256').update(bytes).digest('hex')!==bundle.sha256) throw Error('Invalid candidate bundle');
  if(await this.git(p.repository,['rev-parse','--is-bare-repository'])!=='true') throw Error('Trusted bare object store required');
  const directory=await mkdtemp(join(dirname(this.directory(p.repository)),'candidate-'));
  try {
   const path=join(directory,'candidate.bundle');await writeFile(path,bytes,{mode:0o600});
   if(await this.git(p.repository,['bundle','list-heads',path])!==`${p.head} HEAD`) throw Error('Bundle identity mismatch');
   await this.git(p.repository,['bundle','verify',path]);
   await this.git(p.repository,['-c','fetch.fsckObjects=true','-c','transfer.fsckObjects=true','fetch','--no-tags','--no-write-fetch-head',path,'HEAD']);
   await this.verifyObjects(p);
  } finally {await rm(directory,{recursive:true,force:true});}
 }
 async verifyObjects(p:PublicationPermit):Promise<void> {
  if(await this.git(p.repository,['rev-parse','--is-bare-repository'])!=='true') throw Error('Trusted bare object store required');
  if(await this.git(p.repository,['rev-parse',`${p.head}^{tree}`])!==p.tree) throw Error('Candidate tree drift');
  await this.git(p.repository,['merge-base','--is-ancestor',p.base,p.head]);
  if(p.previousHead) await this.git(p.repository,['merge-base','--is-ancestor',p.previousHead,p.head]);
 }
 async head(repository:string,branch:string):Promise<string|null> {
  const result=await this.git(repository,['ls-remote','--refs',`https://github.com/${repository}.git`,`refs/heads/${branch}`],true);
  if(!result) return null;
  const rows=result.split('\n');if(rows.length!==1) throw Error('Ambiguous remote ref');
  const [sha,ref]=rows[0]!.split(/\s+/);if(!/^[a-f0-9]{40}$/.test(sha!)||ref!==`refs/heads/${branch}`) throw Error('Remote ref mismatch');return sha!;
 }
 async push(p:PublicationPermit):Promise<void> {
  await this.git(p.repository,['push',`--force-with-lease=refs/heads/${p.branch}:${p.previousHead??''}`,`https://github.com/${p.repository}.git`,`${p.head}:refs/heads/${p.branch}`],true);
 }
 async pulls(p:PublicationPermit):Promise<PublishedPull[]> {
  const owner=p.repository.split('/')[0];
  const result=z.array(pull).parse(await this.api(p.repository,`/pulls?state=all&head=${encodeURIComponent(`${owner}:${p.branch}`)}&per_page=100`));
  if(result.length===100) throw Error('Bounded PR inventory exceeded');
  return result.map(pr=>{
   if(pr.head.repo.full_name!==p.repository||pr.base.repo.full_name!==p.repository) throw Error('Repository ownership drift');
   return {number:pr.number,url:pr.html_url,head:pr.head.sha,base:pr.base.sha,baseBranch:pr.base.ref,branch:pr.head.ref,body:pr.body??'',title:pr.title,state:pr.state};
  });
 }
 async create(p:PublicationPermit,body:string):Promise<void> {
  await this.api(p.repository,'/pulls','POST',{head:p.branch,base:p.baseBranch,title:p.title,body,draft:true});
 }
 async update(p:PublicationPermit,pr:PublishedPull,body:string):Promise<void> {
  await this.api(p.repository,`/pulls/${pr.number}`,'PATCH',{title:p.title,body});
 }
}
