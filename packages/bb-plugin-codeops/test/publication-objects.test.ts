// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateBundle, inspect } from '../host.ts';
import { GithubPublication } from '../core/github-publication.ts';
import type { PublicationPermit } from '../core/publication.ts';
const exec=promisify(execFile);
test('real Git exports and imports exact candidate objects without provider access',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'publication-objects-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const worker=join(root,'worker'),trusted=join(root,'trusted'),store=join(trusted,'objects.git');
 await mkdir(worker);await mkdir(trusted,{mode:0o700});
 const git=async(path:string,...args:string[])=> (await exec('git',['-C',path,'-c','core.hooksPath=/dev/null',...args],{
  env:{PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'},timeout:15_000,
 })).stdout.trim();
 await git(worker,'init');await git(worker,'remote','add','origin','https://github.com/example/repository');
 await writeFile(join(worker,'source.txt'),'base\n');await git(worker,'add','source.txt');await git(worker,'commit','-m','Create base');
 const base=await git(worker,'rev-parse','HEAD');
 await git(trusted,'init','--bare',store);await git(store,'fetch','--no-tags','--no-write-fetch-head',worker,base);
 await writeFile(join(worker,'source.txt'),'candidate\n');await git(worker,'add','source.txt');await git(worker,'commit','-m','Update candidate');
 const target={path:worker,repository:'https://github.com/example/repository',base};
 const candidate=await inspect(target),bundle=await candidateBundle({...target,candidate});
 const permit:PublicationPermit={id:'12345678-1234-4234-8234-123456789abc',repository:'example/repository',runId:'run',generation:1,lease:'lease',ownerThreadId:'owner',scopeDigest:'1'.repeat(64),evidenceDigest:'2'.repeat(64),expiresAt:'2099-01-01T00:00:00.000Z',supersedes:null,base,head:candidate.head,tree:candidate.tree,baseBranch:'main',branch:'candidate',previousHead:null,title:'Candidate',body:'Fixture',evidence:['https://example.test/evidence']};
 const adapter=new GithubPublication(new Map([[permit.repository,{directory:store,credentialVariable:'CODEOPS_UNSET_FIXTURE_CREDENTIAL'}]]));
 await adapter.ingestBundle(permit,bundle);await adapter.verifyObjects(permit);
 assert.equal(await git(store,'show',`${candidate.head}:source.txt`),'candidate');
 assert.deepEqual(await readdir(trusted),['objects.git'],'Temporary bundle removed after successful ingestion');
 await assert.rejects(adapter.ingestBundle({...permit,head:'d'.repeat(40)},bundle),/identity/);
 assert.deepEqual(await readdir(trusted),['objects.git'],'Temporary bundle removed after failed identity check');
 await assert.rejects(adapter.ingestBundle(permit,{...bundle,sha256:'0'.repeat(64)}),/Invalid/);
 await assert.rejects(adapter.verifyObjects({...permit,tree:'e'.repeat(40)}),/tree drift/);
 await writeFile(join(worker,'source.txt'),'uncommitted\n');await assert.rejects(candidateBundle({...target,candidate}),/clean/);
});
