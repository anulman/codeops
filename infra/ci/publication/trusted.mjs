// SPDX-License-Identifier: Apache-2.0
// Fixed reviewed entrypoint only. Never load executable code from candidate artifacts.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {identity,hash,validateManifest,cleanup,ensureRef,workflowPath} from './ownership.mjs';
import {prepare} from './candidate.mjs';
import {GithubPublication} from '../../../packages/bb-plugin-codeops/core/github-publication.ts';
import {Publisher} from '../../../packages/bb-plugin-codeops/core/publication.ts';
const Database=createRequire(new URL('../../../packages/bb-plugin-codeops/package.json',import.meta.url))('better-sqlite3');
const repository=process.env.GITHUB_REPOSITORY, trustedSource=process.env.TRUSTED_SOURCE_SHA;
assert.match(repository??'',/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);assert.match(trustedSource??'',/^[a-f0-9]{40}$/);
assert(process.env.GH_TOKEN,'CI repository token required');
const root=resolve(process.env.FIXTURE_STATE??'fixture-evidence');mkdirSync(root,{recursive:true,mode:0o700});
const env={GITHUB_REPOSITORY:repository,GITHUB_RUN_ID:process.env.GITHUB_RUN_ID,TRUSTED_SOURCE_SHA:trustedSource,FIXTURE_STATE:root,PATH:process.env.PATH,HOME:'/nonexistent',GH_CONFIG_DIR:'/nonexistent',GH_HOST:'github.com',GH_TOKEN:process.env.GH_TOKEN,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
function command(binary,args,input,credentials=false){
 try{return execFileSync(binary,args,{input,encoding:'utf8',env:credentials?env:{...env,GH_TOKEN:undefined},stdio:['pipe','pipe','pipe'],timeout:60000,maxBuffer:32*1024*1024}).trim();}
 catch(e){const code=/HTTP (\d{3})/.exec(String(e.stderr))?.[1];throw Error(`Trusted fixture command failed${code?' HTTP '+code:''}; effect may be unknown`);}
}
function api(path,method='GET',value){const args=['api',`repos/${repository}${path}`,'--method',method];if(value!==undefined)args.push('--input','-');return JSON.parse(command('gh',args,value===undefined?undefined:JSON.stringify(value),true)||'null');}
const remote=`https://github.com/${repository}.git`;
const objects=join(root,'objects.git');command('git',['-c','core.hooksPath=/dev/null','init','--bare',objects]);
const git=(args,input,credentials=false)=>command('git',['--git-dir='+objects,'-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','credential.helper=!gh auth git-credential',...args],input,credentials);
const ref=async name=>{const lines=git(['ls-remote','--refs',remote,'refs/heads/'+name],undefined,true);if(!lines)return null;const fields=lines.split(/\s+/);assert.equal(fields.length,2);assert.equal(fields[1],'refs/heads/'+name);assert.match(fields[0],/^[a-f0-9]{40}$/);return fields[0];};
let ownerSha=null,state=null,db=null;
function commitState(value,parent){
 const blob=git(['hash-object','-w','--stdin'],JSON.stringify(value)+'\n');const tree=git(['mktree'],`100644 blob ${blob}\tmanifest.json\n`);
 // Explicit identity passed in Git config, never borrowed from a worker home.
 return command('git',['--git-dir='+objects,'-c','core.hooksPath=/dev/null','-c','user.name=CodeOps fixture','-c','user.email=fixture@example.invalid','commit-tree',tree,...(parent?['-p',parent]:[])],`CodeOps fixture ownership ${value.manifest.identity.key}\n`);
}
async function save(){
 if(db)state.journal=db.serialize().toString('base64');
 const next=commitState(state,ownerSha);
 try{git(['push',`--force-with-lease=refs/heads/${state.manifest.identity.owner}:${ownerSha??''}`,remote,`${next}:refs/heads/${state.manifest.identity.owner}`],undefined,true);}catch(e){if(await ref(state.manifest.identity.owner)!==next)throw e;}
 assert.equal(await ref(state.manifest.identity.owner),next,'Owner checkpoint not verified');ownerSha=next;
 writeFileSync(join(root,'receipt.json'),JSON.stringify({ownerSha,manifest:state.manifest,phase:state.phase},null,2)+'\n');
}
async function load(id){
 const sha=await ref(id.owner);if(!sha)return false;
 git(['fetch','--no-tags',remote,sha],undefined,true);const text=git(['show',`${sha}:manifest.json`]);assert(text.length<4*1024*1024);
 const loaded=JSON.parse(text);validateManifest(loaded.manifest,repository);assert.deepEqual(loaded.manifest.identity,id);assert.equal(loaded.manifest.trustedSource,trustedSource,'Unreviewed fixture source');state=loaded;ownerSha=sha;return true;
}
async function validateRun(m,finished=false){
 validateManifest(m,repository);
 const run=api(`/actions/runs/${m.identity.runId}`);assert.equal(run.repository.full_name,repository);assert.equal(run.path,workflowPath);assert.equal(run.head_sha,m.workflowSha);assert.equal(m.pinnedBase,run.head_sha);assert.equal(run.created_at,m.createdAt);assert(['push','workflow_dispatch','schedule'].includes(run.event));
 if(finished)assert.equal(run.status,'completed');
 // Recompute owned object identities from immutable run metadata. A marker and
 // prefix alone cannot authorize cleanup after process loss or ownership drift.
 const expected=prepare({repository,runId:m.identity.runId,pinnedBase:run.head_sha,trustedSource,createdAt:run.created_at},join(root,'audit-'+m.identity.key));
 for(const field of ['base','head','tree'])assert.equal(m[field],expected[field],'Durable candidate identity drift');
 const shape={...expected,bundleSha256:m.bundleSha256};delete shape.bundle;
 assert.equal(hash(shape),m.candidateSha256,'Durable candidate binding drift');
 return run;
}
const provider={repository,ref,
 async createRef(name,sha){git(['push',`--force-with-lease=refs/heads/${name}:`,remote,`${sha}:refs/heads/${name}`],undefined,true);},
 async verifyOwner(m){assert.equal(await ref(m.identity.owner),ownerSha,'Ownership checkpoint drift');assert.deepEqual(state.manifest,m);await validateRun(m);},
 async finishedRun(m){await validateRun(m,true);return true;},
 async pulls(m){const result=api(`/pulls?state=all&head=${encodeURIComponent(repository.split('/')[0]+':'+m.identity.head)}&per_page=100`);assert(result.length<100,'PR inventory truncated');return result;},
 async pull(number){return api(`/pulls/${number}`);},
 async close(number){api(`/pulls/${number}`,'PATCH',{state:'closed'});},
 async deleteRef(name,sha){git(['push',`--force-with-lease=refs/heads/${name}:${sha}`,remote,`:refs/heads/${name}`],undefined,true);},
 async markClean(m){state.phase='cleaned';m.pr=(await provider.pulls(m))[0]?.number??m.pr;await save();},
};
async function clean(expired=false){if(!state)return;db?.close();db=null;const result=await cleanup(provider,state.manifest,{expired});writeFileSync(join(root,'cleanup.json'),JSON.stringify(result,null,2));if(expired){await provider.deleteRef(state.manifest.identity.owner,ownerSha);assert.equal(await ref(state.manifest.identity.owner),null);}}
async function qualify(file){
 const runId=process.env.GITHUB_RUN_ID,id=identity(repository,runId);const run=api(`/actions/runs/${runId}`);
 const input=JSON.parse(readFileSync(file,'utf8'));assert.equal(input.repository,repository);assert.equal(input.runId,runId);assert.equal(input.trustedSource,trustedSource);assert.equal(input.createdAt,run.created_at);
 // Independently regenerate the complete candidate with trusted code. Never import
 // candidate scripts, workflow files, package manifests, or configuration.
 const regenerated=prepare(input,join(root,'regenerated'));assert.equal(hash(Buffer.from(input.bundle,'base64')),input.bundleSha256);
 assert.deepEqual({...input,bundle:undefined,bundleSha256:undefined},{...regenerated,bundle:undefined,bundleSha256:undefined},'Candidate artifact drift');
 const shape={...input};delete shape.bundle;const candidateSha256=hash(shape);
 const loaded=await load(id);
 if(process.argv[2]==='resume')assert(loaded,'Restart requires durable checkpoint');
 if(loaded&&state.phase==='cleaned'){assert(state.qualified,'Prior attempt failed and was cleaned; do not create new effects');return;}
 if(!loaded){
  for(const name of [id.base,id.head])assert.equal(await ref(name),null,'Fixture ref collision without ownership');
  state={phase:'reserved',journal:null,manifest:validateManifest({schema:'codeops.publication-fixture/v1',identity:id,pinnedBase:input.pinnedBase,base:input.base,head:input.head,tree:input.tree,trustedSource,workflowSha:run.head_sha,createdAt:run.created_at,expiresAt:new Date(Date.parse(run.created_at)+86400000).toISOString(),bundleSha256:input.bundleSha256,candidateSha256,marker:`<!-- codeops-fixture:${id.key}:${candidateSha256} -->`,pr:null,createAttempted:false,createRejected:false},repository)};await save();
 }else{assert.equal(state.manifest.candidateSha256,candidateSha256);assert.notEqual(state.phase,'cleaned','Completed fixture identity cannot be reused');}
 await validateRun(state.manifest);
 // Import local synthetic objects without credentials, then create the exact base.
 git(['fetch',join(root,'regenerated'),input.base]);
 await ensureRef(provider,id.base,input.base);
 const m=state.manifest;
 db=new Database(state.journal?Buffer.from(state.journal,'base64'):join(root,'publisher.sqlite'));
 const adapter=new GithubPublication(new Map([[repository,{directory:objects,credentialVariable:'GH_TOKEN'}]]));
 let loseCreate=true,loseUpdate=true;
 const wrapped={prepareObjects:adapter.prepareObjects.bind(adapter),verifyObjects:adapter.verifyObjects.bind(adapter),head:adapter.head.bind(adapter),pulls:adapter.pulls.bind(adapter),
  async push(p){await save();await adapter.push(p);},
  async create(p,body){state.manifest.createAttempted=true;await save();try{await adapter.create(p,body);}catch(error){if(error.message.includes('repository Actions PR creation is disabled'))state.manifest.createRejected=true;writeFileSync(join(root,'provider-denial.json'),JSON.stringify({error:error.message,action:'create pull request',workerAuthUsed:false}));throw error;}if(loseCreate){loseCreate=false;throw Error('Deliberate response loss after actual create');}},
  async update(p,pr,body){await save();await adapter.update(p,pr,body);if(loseUpdate){loseUpdate=false;throw Error('Deliberate response loss after actual update');}},
 };
 let publisher=new Publisher(db,wrapped,async p=>p.runId===id.runId&&p.head===m.head&&await ref(id.owner)===ownerSha);
 const uuid=hash(id.key).slice(0,32);const permit={id:`${uuid.slice(0,8)}-${uuid.slice(8,12)}-4${uuid.slice(13,16)}-8${uuid.slice(17,20)}-${uuid.slice(20)}`,repository,runId:id.runId,generation:1,lease:id.key,ownerThreadId:'fixture-'+id.key,scopeDigest:hash('fixture-only'),evidenceDigest:candidateSha256,base:m.base,head:m.head,tree:m.tree,baseBranch:id.base,branch:id.head,previousHead:null,supersedes:null,expiresAt:m.expiresAt,title:'CodeOps publication qualification',body:m.marker,evidence:[run.html_url]};
 const payload={data:input.bundle,sha256:input.bundleSha256};publisher.admit(permit);await save();
 try{await publisher.publish(permit.id,payload);}catch(e){await save();if(!await publisher.recover(permit.id))throw e;}
 await save();
 if(process.argv[2]!=='resume'){
  // A separate process must recover from the durable remote checkpoint, not an
  // in-memory reconstruction. CI always-cleanup covers termination at this edge.
  db.close();db=null;state=null;
  command(process.execPath,['--experimental-transform-types',new URL(import.meta.url).pathname,'resume',file],undefined,true);
  return;
 }
 db.close();db=new Database(Buffer.from(state.journal,'base64'));publisher=new Publisher(db,wrapped,async p=>p.runId===id.runId&&p.head===m.head&&await ref(id.owner)===ownerSha);
 const receipt=await publisher.recover(permit.id);assert(receipt);m.pr=receipt.number;await save();
 assert.equal((await publisher.publish(permit.id,payload)).number,m.pr,'Duplicate publication');
 // A second admitted permit reuses the exact candidate and exercises real PR update.
 const second={...permit,id:permit.id.slice(0,-1)+(permit.id.endsWith('0')?'1':'0'),previousHead:m.head,supersedes:permit.id,title:'CodeOps publication qualification verified'};
 publisher.admit(second);await save();
 try{await publisher.publish(second.id,payload);}catch(e){await save();if(!await publisher.recover(second.id))throw e;}
 await save();assert.equal((await publisher.publish(second.id,payload)).number,m.pr);
 state.phase='qualified';state.qualified=true;await save();writeFileSync(join(root,'qualification.json'),JSON.stringify({status:'passed',actualGithub:true,createResponseLoss:true,updateResponseLoss:true,restartRecovery:true,idempotent:true,pr:m.pr,head:m.head},null,2));
}
let failure;
try{
 const mode=process.argv[2];
 if(mode==='qualify'||mode==='resume')await qualify(process.argv[3]);
 else if(mode==='cleanup'){await load(identity(repository,process.env.GITHUB_RUN_ID));}
 else if(mode==='expire'){
  const refs=api('/git/matching-refs/heads/bb-qualification/publication/');assert(refs.length<=300,'Expiry inventory bound exceeded');
  for(const item of refs.filter(x=>/^refs\/heads\/bb-qualification\/publication\/[a-f0-9]{32}\/owner$/.test(x.ref)).slice(0,100)){
   git(['fetch','--no-tags',remote,item.object.sha],undefined,true);const candidate=JSON.parse(git(['show',`${item.object.sha}:manifest.json`]));validateManifest(candidate.manifest,repository);
   if(Date.now()<Date.parse(candidate.manifest.expiresAt))continue;
   await load(candidate.manifest.identity);await clean(true);state=null;
  }
 }else throw Error('Unknown mode');
}catch(e){failure=String(e.message).slice(0,500);writeFileSync(join(root,'failure.json'),JSON.stringify({status:'failed',error:failure,actualGithubQualified:false}));}
finally{if(state&&process.argv[2]!=='expire'){try{await clean();}catch(e){writeFileSync(join(root,'cleanup-failure.json'),JSON.stringify({error:String(e.message).slice(0,500),retainedOwner:state.manifest.identity.owner}));failure??='Cleanup failed; durable ownership retained';}}}
if(failure){console.error(failure);process.exitCode=1;}
