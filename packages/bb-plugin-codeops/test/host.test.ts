// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspect,identity } from '../host.ts';

test('host reads real Git identities and rejects dirty or substituted repositories',async()=>{
  const path=await mkdtemp(join(tmpdir(),'codeops-git-test-'));
  const env={PATH:process.env.PATH,HOME:path,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'};
  const git=(...args:string[])=>execFileSync('git',['-C',path,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    git('init');git('remote','add','origin','https://github.com/example/repository');await writeFile(join(path,'file.txt'),'source\n');git('add','.');git('commit','-m','Initial fixture');
    const base=git('rev-parse','HEAD'),target={path,repository:'https://github.com/example/repository',base};
    const result=await inspect(target);assert.equal(result.head,base);assert.equal(result.tree,git('rev-parse','HEAD^{tree}'));assert.deepEqual(result.files,[]);
    await assert.rejects(identity({...target,repository:'https://github.com/another/repository'}),/identity drift/);
    await writeFile(join(path,'file.txt'),'changed\n');await assert.rejects(inspect(target),/committed and clean/);
    // Identity readback remains possible while the authorized worker edits.
    assert.deepEqual(await identity(target),{valid:true});
  } finally {await rm(path,{recursive:true,force:true});}
});
