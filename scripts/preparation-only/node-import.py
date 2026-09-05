"""Unadmitted bounded OCI -> Docker-save adapter. No execution or layer extraction."""
import tarfile,json,hashlib,gzip,tempfile,io,pathlib,os
PIN='sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2'
def require(v):
 if not v:raise ValueError('Node input refused')
def convert(fd,receipt,destination):
 require(receipt['sourceIndex']==PIN)
 require(os.fstat(fd.fileno()).st_size==receipt['bytes'])
 fd.seek(0);require(hashlib.file_digest(fd,'sha256').hexdigest()==receipt['sha256']);fd.seek(0)
 path=pathlib.Path(destination);require(not path.exists())
 with tarfile.open(fileobj=fd,mode='r:') as t:
  ms=t.getmembers();require(len(ms)<=32 and all(m.isfile() and not m.sparse for m in ms));by={m.name:m for m in ms};require(len(by)==len(ms))
  def blob(d,size,cap):
   require(size<=cap);m=by['blobs/sha256/'+d.split(':')[1]];require(m.size==size)
   return t.extractfile(m)
  def json_blob(d,size):
   with blob(d,size,1024**2) as f:raw=f.read(1024**2+1)
   require('sha256:'+hashlib.sha256(raw).hexdigest()==d);return json.loads(raw),raw
  idxm=by['blobs/sha256/'+PIN[7:]];idx,_=json_blob(PIN,idxm.size)
  selected=[m for m in idx['manifests'] if m.get('platform',{}).get('architecture')=='amd64' and m.get('platform',{}).get('os')=='linux'];require(selected==[receipt['platform']])
  manifest,_=json_blob(selected[0]['digest'],selected[0]['size']);require(manifest['layers']==receipt['layers'] and manifest['config']==receipt['config'])
  config,raw=json_blob(manifest['config']['digest'],manifest['config']['size']);require(config['os']=='linux' and config['architecture']=='amd64');require(config['rootfs']['diff_ids']==receipt['diffIds']);require(len(manifest['layers'])==len(receipt['diffIds']) and len(manifest['layers'])>0)
  part=path.with_suffix('.partial');require(not part.exists())
  try:
   with part.open('xb') as sink,tarfile.open(fileobj=sink,mode='w',format=tarfile.USTAR_FORMAT) as out:
    def add(name,src,size):
     i=tarfile.TarInfo(name);i.mode=0o444;i.size=size;out.addfile(i,src)
    cn=manifest['config']['digest'][7:]+'.json';add(cn,io.BytesIO(raw),len(raw));names=[];total=0
    for layer,diff in zip(manifest['layers'],receipt['diffIds']):
     with blob(layer['digest'],layer['size'],1024**3) as source:require('sha256:'+hashlib.file_digest(source,'sha256').hexdigest()==layer['digest'])
     with blob(layer['digest'],layer['size'],1024**3) as source,gzip.GzipFile(fileobj=source) as z,tempfile.TemporaryFile(dir=str(path.parent)) as plain:
      h=hashlib.sha256();n=0
      while b:=z.read(1048576):
       n+=len(b);total+=len(b);require(n<=1024**3 and total<=2*1024**3);h.update(b);plain.write(b)
      require('sha256:'+h.hexdigest()==diff);plain.seek(0);name=diff[7:]+'/layer.tar';names.append(name);add(name,plain,n)
    raw=json.dumps([{'Config':cn,'RepoTags':[],'Layers':names}],sort_keys=True).encode();add('manifest.json',io.BytesIO(raw),len(raw))
   os.rename(part,path)
  except BaseException:
   if part.exists():part.unlink()
   raise
 return str(path)
