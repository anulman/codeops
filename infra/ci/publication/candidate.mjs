// SPDX-License-Identifier: Apache-2.0
// Run only in the credential-free network-none candidate container.
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {identity,hash} from './ownership.mjs';
export function prepare({repository,runId,pinnedBase,trustedSource,createdAt},directory) {
 assert.match(pinnedBase,/^[a-f0-9]{40}$/);assert.match(trustedSource,/^[a-f0-9]{40}$/);
 const id=identity(repository,runId);const root=resolve(directory);mkdirSync(root,{recursive:true});
 const env={PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'CodeOps fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'CodeOps fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid',GIT_AUTHOR_DATE:createdAt,GIT_COMMITTER_DATE:createdAt};
 const git=(args,input)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-C',root,...args],{env,input,encoding:'utf8'}).trim();
 git(['init','--quiet']);
 // A synthetic empty base prevents ANY repository workflow/app file executing.
 // pinnedBase is recorded provenance, never modified or used as a cleanup target.
 const empty=git(['mktree'],'');const base=git(['commit-tree',empty],`CodeOps fixture base\n${id.key}\nPinned source ${pinnedBase}\n`);
 const content=JSON.stringify({purpose:'publication-qualification',repository,runId:String(runId),pinnedBase,trustedSource})+'\n';
 const blob=git(['hash-object','-w','--stdin'],content);const tree=git(['mktree'],`100644 blob ${blob}\tqualification.json\n`);
 const head=git(['commit-tree',tree,'-p',base],`CodeOps fixture candidate\n${id.key}\n`);
 git(['update-ref','refs/heads/candidate',head]);git(['symbolic-ref','HEAD','refs/heads/candidate']);
 git(['bundle','create',join(root,'candidate.bundle'),'HEAD']);
 const bundle=readFileSync(join(root,'candidate.bundle'));const candidate={schema:'codeops.fixture-candidate/v1',repository,runId:String(runId),pinnedBase,trustedSource,createdAt,base,head,tree,content,bundle:bundle.toString('base64'),bundleSha256:hash(bundle)};
 writeFileSync(join(root,'candidate.json'),JSON.stringify(candidate));return candidate;
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 assert(!Object.keys(process.env).some(k=>/TOKEN|SECRET|AUTH/.test(k)),'Candidate environment contains credential variables');
 const input=JSON.parse(readFileSync(process.argv[2],'utf8'));prepare(input,process.argv[3]);
}
