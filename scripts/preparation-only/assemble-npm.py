"""Unadmitted deterministic archive constructor; never extracts or runs packages.
Run only inside reviewed capped boundary, sealed input FDs, fresh private scratch.
Produces /work-root-relative dependencies for existing import-owned path.
"""
import tarfile,hashlib,json,io,os,importlib.util,pathlib
s=importlib.util.spec_from_file_location('immutable','/packet/immutable-input.py');im=importlib.util.module_from_spec(s);s.loader.exec_module(im)
def require(v):
 if not v:raise ValueError('layout refusal')
def assemble(plan,admission,output):
 require(plan['sourceCommit']==admission['sourceCommit'])
 require(hashlib.sha256(json.dumps(plan,sort_keys=True).encode()).hexdigest()==admission['layoutCanonicalSha256'])
 require(len(plan['packages'])==44 and len(admission['packages'])==44)
 part=pathlib.Path(output+'.partial');require(not part.exists() and not pathlib.Path(output).exists())
 seen={};total=0;consumed=0
 aliases=plan['aliases'];require(len(aliases)==2)
 allowed={}
 for alias in aliases:
  require(alias['package'] in ('node_modules/agent-base','node_modules/https-proxy-agent'))
  require(alias['inputs']==['package/./dist/index.js','package/dist/index.js'])
  require(alias['target']==alias['package']+'/dist/index.js' and alias['target'] not in allowed)
  allowed[alias['target']]=alias
 groups={}
 for pkg in plan['packages']:
  for row in pkg['members']:groups.setdefault(row['target'],[]).append((pkg['path'],row))
 for name,rows in groups.items():
  if len(rows)>1:
   require(name in allowed);a=allowed[name]
   require(len(rows)==2 and sorted(r['input'] for _,r in rows)==a['inputs'])
   require(all(owner==a['package'] and all(r[k]==a[k] for k in ('size','sha256','mode')) for owner,r in rows))
 require({n for n,rows in groups.items() if len(rows)>1}==set(allowed))
 directories=set()
 for pkg in plan['packages']:
  for row in pkg['members']:
   parts=row['target'].split('/')
   require(all(x not in ('','.','..') for x in parts))
   directories.update('/'.join(parts[:i]) for i in range(1,len(parts)))
 directories.update(['node_modules','node_modules/@codeops'])
 require(len(directories)<=2048 and not (set(groups)&directories))
 require(plan['workspaceLink']['path'] not in groups and plan['workspaceLink']['path'] not in directories)
 try:
  with part.open('xb') as sink,tarfile.open(fileobj=sink,mode='w',format=tarfile.USTAR_FORMAT) as out:
   for name in sorted(directories,key=lambda x:(x.count('/'),x)):
    info=tarfile.TarInfo(name);info.type=tarfile.DIRTYPE;info.mode=0o755;info.uid=info.gid=1000;out.addfile(info)
   for pkg,binding in zip(plan['packages'],admission['packages']):
    require(binding['sha256']==pkg['sha256'])
    expected={m['input']:m for m in pkg['members']};require(len(expected)==len(pkg['members']))
    # Protected fs-verity/hash verification before tar parser, same FD throughout.
    with im.open_verified(binding['path'],pkg['sha256'],binding['veritySha256'],64*1024**2) as f:
     require(os.fstat(f.fileno()).st_size==pkg['bytes'])
     with tarfile.open(fileobj=f,mode='r:gz') as src:
      for m in src:
       require(m.isfile() or m.isdir());require(not m.sparse)
       if m.isdir():continue
       require(m.name in expected);row=expected.pop(m.name);name=row['target']
       require(name.startswith('node_modules/') and all(x not in ('','.','..') for x in name.split('/')) and name not in directories)
       require(m.size==row['size'] and m.size<=32*1024**2 and m.mode==row['mode'])
       raw=src.extractfile(m).read(m.size+1);require(len(raw)==m.size and hashlib.sha256(raw).hexdigest()==row['sha256'])
       consumed+=1
       if name in seen:
        require(name in allowed and seen[name]==(row['sha256'],m.mode,m.size));continue
       seen[name]=(row['sha256'],m.mode,m.size);total+=m.size;require(total<=64*1024**2 and len(seen)<=4096)
       info=tarfile.TarInfo(name);info.size=m.size;info.mode=0o644;info.uid=info.gid=1000;out.addfile(info,io.BytesIO(raw))
     require(not expected)
   require(consumed==plan['inputRegularFiles'] and len(seen)==plan['outputRegularFiles'] and total==plan['outputRegularBytes'])
   link=plan['workspaceLink'];require(link=={'path':'node_modules/@codeops/codeops-contracts','target':'../../packages/codeops-contracts'})
   require(link['path'] not in seen);info=tarfile.TarInfo(link['path']);info.type=tarfile.SYMTYPE;info.linkname=link['target'];info.mode=0o777;info.uid=info.gid=1000;out.addfile(info)
  require(part.stat().st_size<=80*1024**2);os.rename(part,output)
 except BaseException:
  if part.exists():part.unlink()
  raise
