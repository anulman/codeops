"""Future root-owned public input reconstruction only; never execute repository code.
Exact upstream bytes, fresh protected scratch; partial objects preserved on refusal.
No registry/login credential lookup. Anonymous pull token is memory-only, never logged.
"""
import os,pathlib,subprocess,resource,json,hashlib,tarfile,urllib.request,urllib.parse

def need(v):
 if not v:raise ValueError('public reconstruction refused')
def digest(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def caps():
 resource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2));resource.setrlimit(resource.RLIMIT_FSIZE,(128*1024**2,128*1024**2));resource.setrlimit(resource.RLIMIT_CPU,(90,90));resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
def git(args,cwd,out=None):
 # No hooks, filters, config credential helpers, checkout, or submodule execution.
 env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LANG':'C','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_ALLOW_PROTOCOL':'https','GIT_ATTR_NOSYSTEM':'1'}
 subprocess.run(['/usr/bin/git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','credential.helper=',*args],cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=out if out else subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=120,preexec_fn=caps,close_fds=True)
def acquire(item,base,receipt):
 base=pathlib.Path(base);target=base/'downloads'/item['sha256'];need(not target.exists())
 work=base/'scratch'/item['sha256'];work.mkdir(mode=0o700)
 if item['method']=='public exact git archive':
  need(item['commit']=='36c1455751b14c6da2d90f9603f0cf5b74562fae' and item['url']=='https://github.com/anulman/codeops.git')
  git(['init','--bare','.'],work);git(['fetch','--depth=1','--no-tags',item['url'],item['commit']],work)
  with target.open('xb') as out:git(['archive','--format=tar',item['commit']],work,out)
 else:
  need(item['method']=='public pinned Node OCI reconstruction' and item['sha256']==receipt['sha256'])
  need(receipt['sourceIndex']=='sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2')
  root=work/'oci';blobs=root/'blobs'/'sha256';blobs.mkdir(parents=True,mode=0o700)
  with urllib.request.urlopen('https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull',timeout=30) as src:
   raw=src.read(65537);need(len(raw)<=65536);token=json.loads(raw)['token'];need(isinstance(token,str) and len(token)<16384)
  def fetch(d,kind,size):
   need(d.startswith('sha256:') and len(d)==71 and all(c in '0123456789abcdef' for c in d[7:]))
   path=blobs/d[7:];need(not path.exists());h=hashlib.sha256();n=0
   request=urllib.request.Request('https://registry-1.docker.io/v2/library/node/'+kind+'/'+d,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json'})
   with urllib.request.urlopen(request,timeout=60) as src,path.open('xb') as out:
    need(urllib.parse.urlparse(src.url).scheme=='https')
    while b:=src.read(1048576):
     n+=len(b);need(n<=size);h.update(b);out.write(b)
   need(h.hexdigest()==d[7:]);return path,n
  idx,n=fetch(receipt['sourceIndex'],'manifests',1024**2)
  index=json.loads(idx.read_bytes());selected=[x for x in index['manifests'] if x.get('platform',{}).get('architecture')=='amd64' and x.get('platform',{}).get('os')=='linux'];need(selected==[receipt['platform']])
  desc=receipt['platform'];m,n=fetch(desc['digest'],'manifests',desc['size']);need(n==desc['size']);manifest=json.loads(m.read_bytes());need(manifest['config']==receipt['config'] and manifest['layers']==receipt['layers'])
  for desc in [manifest['config']]+manifest['layers']:
   _,n=fetch(desc['digest'],'blobs',desc['size']);need(n==desc['size'])
  config=json.loads((blobs/receipt['config']['digest'][7:]).read_bytes());need(config['architecture']=='amd64' and config['os']=='linux' and config['rootfs']['diff_ids']==receipt['diffIds'] and len(manifest['layers'])==len(receipt['diffIds']))
  (root/'oci-layout').write_text('{"imageLayoutVersion":"1.0.0"}\n');(root/'index.json').write_text(json.dumps({'schemaVersion':2,'manifests':selected},sort_keys=True)+'\n')
  with target.open('xb') as out,tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as t:
   for path in sorted(root.rglob('*')):
    if path.is_file():
     info=t.gettarinfo(str(path),str(path.relative_to(root)));info.uid=info.gid=info.mtime=0;info.uname=info.gname='';info.mode=0o444
     with path.open('rb') as src:t.addfile(info,src)
 need(target.stat().st_size==item['bytes'] and digest(target)==item['sha256']);target.chmod(0o400);return target
