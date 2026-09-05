import hashlib,json,os,pathlib
COMMIT='36c1455751b14c6da2d90f9603f0cf5b74562fae'
SOURCE='2e7e297a73d8424077959e5c948852c6a42068991ea9390238d7162074d25a48'
LOCK='76ab6b4eb703b2298b70a0f3e158dbfa63f1f6fd01afd64184b8de4e9133c30a'
def need(v):
 if not v:raise ValueError('clean binding refusal')
def canonical(x):return hashlib.sha256(json.dumps(x,sort_keys=True).encode()).hexdigest()
def validate(a):
 l=a['npmLayout'];n=a['npmAdmission'];r=a['runner'];receipt=a['nodeReceipt']
 need(a['sourceCommit']==l['sourceCommit']==n['sourceCommit']==COMMIT)
 need(l['lockSha256']==LOCK and a['source']['sha256']==SOURCE and a['source']['commit']==COMMIT and a['source']['lockSha256']==LOCK)
 need(canonical(l)==a['layoutCanonicalSha256']==n['layoutCanonicalSha256'])
 need(len(l['packages'])==len(n['packages'])==44)
 need(r['sourceIndex']==receipt['sourceIndex'] and r['sha256']==receipt['sha256'] and r['imageId']==receipt['imageId']==receipt['config']['digest'])
 need(len(receipt['layers'])==len(receipt['diffIds'])==8)
 paths=[]
 for pkg,binding in zip(l['packages'],n['packages']):
  need(pkg['sha256']==binding['sha256']);paths.append(binding['path'])
 paths += [a['source']['path'],r['path']]
 need(len(paths)==len(set(paths)))
 for item in [a['source'],r]+n['packages']:
  need(item['path'].startswith('/inputs/') and len(item['veritySha256'] or '')==64)
 need(a['requiredPostStagingFreeBytes']==16*1024**3 and a['runId'] and a['bootId'] and a['pidNamespace'])
 return True
def bind(template,proofs,context,module_hashes):
 a=json.loads(json.dumps(template));l=a['npmLayout'];need(set(proofs)=={'source','runner'}|{'npm-'+str(i).zfill(2) for i in range(44)})
 for name,item in [('source',a['source']),('runner',a['runner'])]+[('npm-'+str(i).zfill(2),b) for i,b in enumerate(a['npmAdmission']['packages'])]:
  proof=proofs[name];need(proof['sha256']==item['sha256']);item.update(path='/inputs/'+name+'.tar',veritySha256=proof['veritySha256'],bytes=proof['bytes'],device=proof['device'],inode=proof['inode'])
 a.update({k:context[k] for k in ['runId','bootId','pidNamespace','packetSha256','runtimeTreeSha256','runtimeRoot','runtimeIdentities','preparationCgroup','githubRunId','attempt']})
 a['collectorPending']={'group':None,'groupIdentity':None,'observedWorkerMountPolicy':None,'reason':'Not created by preparation-only; independent hosted admission must supply actual group/mount observations before collector/worker launch'}
 a['modules']=module_hashes;a['decision']='NOT_ADMITTED';a['mode']='compiler-fit';a['executionAdmitted']=False
 validate(a);return a
