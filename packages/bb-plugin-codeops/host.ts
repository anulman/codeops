// SPDX-License-Identifier: Apache-2.0
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, mkdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostContract } from './host-contract.ts';
import { digest, type Candidate, type Brief } from './core/model.ts';
const exec = promisify(execFile);
const environment = { PATH:'/usr/local/bin:/usr/bin:/bin', HOME:'/nonexistent', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0' };
async function git(path:string,args:string[]):Promise<string> {
  const result = await exec('git',['-C',path,'-c','core.hooksPath=/dev/null',...args], {env:environment,timeout:15000,maxBuffer:2*1024*1024});
  return result.stdout.trim();
}
export async function identity(target:{path:string;repository:string;base:string}) {
  if (await realpath(target.path) !== target.path) throw new Error('Workspace must be a canonical path');
  const remote = await git(target.path,['remote','get-url','origin']);
  if (remote.replace(/\.git$/,'') !== target.repository.replace(/\.git$/,'')) throw new Error('Repository identity drift');
  await git(target.path,['merge-base','--is-ancestor',target.base,'HEAD']);
  return {valid:true as const};
}
export async function inspect(target:{path:string;repository:string;base:string}):Promise<Candidate> {
  await identity(target);
  if (await git(target.path,['status','--porcelain','--untracked-files=all'])) throw new Error('Candidate must be committed and clean');
  return {head:await git(target.path,['rev-parse','HEAD']),tree:await git(target.path,['rev-parse','HEAD^{tree}']),
    files:(await git(target.path,['diff','--name-only',target.base,'HEAD'])).split('\n').filter(Boolean)};
}
/** No inherited credentials, home mount, network, writable source or shell expansion. */
export async function isolatedCheck(target:{path:string;repository:string;base:string;candidate:Candidate;check:Brief['checks'][number]},signal:AbortSignal) {
  const before = await inspect(target);
  if (digest(before) !== digest(target.candidate)) throw new Error('Candidate changed before validation');
  // Probe BEFORE executing repository-controlled commands. Fail closed on unsupported hosts.
  await exec('bwrap',['--unshare-all','--die-with-parent','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--','/bin/true'],{env:environment,signal,timeout:10000});
  const root = await mkdtemp(join(tmpdir(),'codeops-check-'));
  try {
    const archive = await exec('git',['-C',target.path,'archive','--format=tar',target.candidate.head],{env:environment,encoding:'buffer',timeout:30000,maxBuffer:64*1024*1024,signal});
    await writeFile(join(root,'candidate.tar'),archive.stdout);
    await mkdir(join(root,'work'));
    await exec('tar',['-xf',join(root,'candidate.tar'),'-C',join(root,'work')],{env:environment,timeout:30000,signal});
    const args = ['--unshare-all','--die-with-parent','--new-session','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
      '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--bind',join(root,'work'),'/work','--chdir','/work','--clearenv','--setenv','PATH','/usr/local/bin:/usr/bin:/bin','--setenv','HOME','/tmp'];
    // Dependencies are deliberately absent. Checks must use committed inputs and system tools.
    // A dependency-cache transport requires its own pinned-content/isolation contract.
    if (existsSync('/usr/local')) args.push('--ro-bind','/usr/local','/usr/local');
    args.push('--',...target.check.argv);
    let exitCode = 0; let output = '';
    try { const result = await exec('bwrap',args,{env:environment,signal,timeout:120000,maxBuffer:1024*1024});output=result.stdout+result.stderr; }
    catch (error) {
      const e = error as {code?:number;stdout?:string;stderr?:string;killed?:boolean};
      if (signal.aborted || e.killed || typeof e.code !== 'number') throw new Error('Check interrupted or launcher unavailable');
      exitCode=e.code;output=(e.stdout??'')+(e.stderr??'');
    }
    if (digest(await inspect(target)) !== digest(before)) throw new Error('Candidate changed during validation');
    return {name:target.check.name,candidate:before.head,tree:before.tree,argvDigest:digest(target.check.argv),exitCode,outputDigest:digest(output),isolation:'bwrap-unshare-all' as const};
  } finally { await rm(root,{recursive:true,force:true}); }
}
export default experimental_defineHostEntry({ contract:hostContract, handlers:{
  identity: input => identity(input), inspect: input => inspect(input), check:(input,context) => isolatedCheck(input,context.signal),
} });
