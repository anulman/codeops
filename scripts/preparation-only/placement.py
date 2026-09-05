"""Future reviewed root placement. Platform Python stdlib bootstrap; no local imports until verified.
Fixed paths, release asset identities, exact member extraction; no package installation.
"""
import os,sys,stat,json,hashlib,pathlib,tarfile,subprocess,urllib.request,urllib.parse,uuid,importlib.util
B=pathlib.Path('/opt/codeops-preparation');P=B/'packet'
def need(v):
    if not v:raise ValueError('placement refused')
def sha(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def write(p,b,mode=0o400):
    fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,'wb') as f:f.write(b);f.flush();os.fsync(f.fileno())
def doc(p,x):write(p,json.dumps(x,sort_keys=True).encode())
def protected(p,directory=False):
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for i,n in enumerate(p.parts[1:]):
            s=os.fstat(fd);need(s.st_uid==0 and not s.st_mode&0o022)
            nf=os.open(n,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_DIRECTORY if i<len(p.parts)-2 or directory else 0),dir_fd=fd);os.close(fd);fd=nf
        s=os.fstat(fd);need(s.st_uid==0 and not s.st_mode&0o022)
        need(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode));return fd
    except BaseException:os.close(fd);raise
def j(p):
    fd=protected(p)
    with os.fdopen(fd,'rb') as f:need(os.fstat(f.fileno()).st_size<8*1024**2);return json.load(f)
def module(n):
    s=importlib.util.spec_from_file_location(n,P/(n+'.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def host():
    paths=['/usr/bin/sudo','/usr/bin/env','/usr/bin/timeout','/usr/bin/bash','/usr/bin/python3','/usr/bin/dpkg-deb','/usr/bin/gzip','/usr/bin/xz','/usr/bin/zstd','/usr/bin/git']
    tools={}
    for name in paths:
        p=pathlib.Path(name).resolve();fd=protected(p);st=os.fstat(fd);os.close(fd)
        tools[name]={'resolved':str(p),'sha256':sha(p),'mode':stat.S_IMODE(st.st_mode),'uid':st.st_uid,'gid':st.st_gid,'device':st.st_dev,'inode':st.st_ino}
    mappings={}
    for line in pathlib.Path('/proc/self/maps').read_text().splitlines():
        v=line.split()
        if len(v)>=6 and v[-1].startswith('/') and 'x' in v[1]:
            p=pathlib.Path(v[-1]);fd=protected(p);os.close(fd);mappings[str(p)]=sha(p)
    return {'tools':tools,'interpreterMappings':mappings,'trust':'observed hosted platform bootstrap; not prior-VM pins'}
def acquire(item):
    # Only original pinned upstream routes. Publication/credentials are never fallbacks.
    need(item['method']=='original upstream HTTPS download')
    url=item['url'];parsed=urllib.parse.urlparse(url)
    need(parsed.scheme=='https' and parsed.hostname in ('archive.ubuntu.com','download.docker.com','github.com','registry.npmjs.org'))
    need(not parsed.username and not parsed.password and not parsed.query and not parsed.fragment)
    target=B/'downloads'/item['sha256'];h=hashlib.sha256();size=0
    req=urllib.request.Request(url,headers={'User-Agent':'codeops-preparation'})
    with urllib.request.urlopen(req,timeout=30) as response:
        need(urllib.parse.urlparse(response.url).scheme=='https')
        need(urllib.parse.urlparse(response.url).hostname in ('archive.ubuntu.com','download.docker.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','registry.npmjs.org'))
        fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
        with os.fdopen(fd,'wb') as out:
            while b:=response.read(1024*1024):
                size+=len(b);need(size<=item['bytes']);h.update(b);out.write(b)
            out.flush();os.fsync(out.fileno())
    need(size==item['bytes'] and h.hexdigest()==item['sha256']);return target

def main():
    need(os.geteuid()==0 and len(sys.argv)==4)
    commit,run,attempt=sys.argv[1:];need(len(commit)==40 and all(x in '0123456789abcdef' for x in commit));need(run.isdigit() and attempt.isdigit())
    manifest=j(P/'PACKET.json');need(set(x.name for x in P.iterdir())==set(manifest['files'])|{'PACKET.json'})
    for n,h in manifest['files'].items():
        need('/' not in n);fd=protected(P/n);st=os.fstat(fd);os.close(fd);need(stat.S_IMODE(st.st_mode)==0o444 and sha(P/n)==h)
    # Only now is local import allowed. bootstrap.sh already authenticated placement.py.
    c=module('control-common');t=module('runtime-topology');plan=j(P/'RUNTIME-ROOT-PLAN.json')
    for n in ('scratch','downloads','runs'): (B/n).mkdir(mode=0o700)
    boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip();ns=os.readlink('/proc/self/ns/pid')
    need(ns==os.readlink('/proc/1/ns/pid'))
    need(pathlib.Path('/proc/self/status').read_text().split('NSpid:')[1].splitlines()[0].split()==[str(os.getpid())])
    group=pathlib.Path('/proc/self/cgroup').read_text();runid=str(uuid.uuid4());root=B/'runs'/runid;root.mkdir(mode=0o700)
    context={'commit':commit,'githubRunId':run,'attempt':attempt,'runId':runid,'bootId':boot,'pidNamespace':ns,'preparationCgroup':group,'packetSha256':sha(P/'PACKET.json'),'runRoot':str(root),'rootIdentity':[root.stat().st_dev,root.stat().st_ino],'executionAdmitted':False,'hostBootstrap':host()}
    doc(B/'context.json',context)
    closure=j(P/'ACQUISITION.json');need(closure['ready'] is True)
    layout=j(P/'NPM-LAYOUT.json');template=j(P/'ADMISSION-TEMPLATE.json');node=j(P/'NODE-OCI-RECEIPT.json')
    need(template['npmLayout']==layout and template['nodeReceipt']==node)
    need(template['source']['sha256']==closure['inputs']['source']['sha256'] and template['runner']['sha256']==closure['inputs']['runner']['sha256'])
    need(template['layoutCanonicalSha256']==hashlib.sha256(json.dumps(layout,sort_keys=True).encode()).hexdigest())
    for i,pkg in enumerate(layout['packages']):
        name='npm-'+str(i).zfill(2);need(closure['inputs'][name]['sha256']==pkg['sha256'])
        original=closure['objects'][pkg['sha256']];need(original['bytes']==pkg['bytes'] and original['url']==pkg['resolved'] and original['integrity']==pkg['integrity'])
    paths={}
    for h,item in closure['objects'].items():
        need(h==item['sha256'])
        if item['method']=='original upstream HTTPS download':paths[h]=acquire(item)
        else:paths[h]=module('public-reconstruct').acquire(item,B, j(P/'NODE-OCI-RECEIPT.json'))
        need(sha(paths[h])==h and paths[h].stat().st_size==item['bytes'])
    runtime=B/'runtime';runtime.mkdir(mode=0o700);tree=t.expected(plan,manifest)
    for n,item in tree.items():
        if item['type']=='dir':(runtime/n).mkdir(parents=True,exist_ok=True,mode=0o755)
    seen=set()
    for archive in plan['archives']:
        path=paths[archive['sha256']];desired={v['member']:(n,v) for n,v in plan['members'].items() if v.get('archiveSha256')==archive['sha256'] and 'sha256' in v}
        proc=None
        if archive['path'].endswith('.deb'):
            proc=subprocess.Popen(['/usr/bin/dpkg-deb','--fsys-tarfile',str(path)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={'PATH':'/usr/bin','LANG':'C'},close_fds=True);stream=tarfile.open(fileobj=proc.stdout,mode='r|')
        else:stream=tarfile.open(path,'r:gz')
        try:
            count=0
            for member in stream:
                count+=1;need(count<100000)
                if member.name not in desired:continue
                n,v=desired[member.name];need(n not in seen and member.isfile() and not member.sparse and member.size==v['size']);seen.add(n)
                target=runtime/n;src=stream.extractfile(member);h=hashlib.sha256();fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,v['mode']&0o555)
                with src,os.fdopen(fd,'wb') as out:
                    while b:=src.read(1048576):out.write(b);h.update(b)
                need(h.hexdigest()==v['sha256']);target.chmod(v['mode']&0o555)
        finally:
            stream.close()
            if proc:
                try:need(proc.wait(timeout=10)==0)
                finally:
                    if proc.poll() is None:proc.kill();proc.wait()
    need(seen=={n for n,v in plan['members'].items() if 'sha256' in v})
    for n,v in tree.items():
        if v['type']=='link':t.resolve(tree,n);(runtime/n).symlink_to(v['link'])
        elif n.startswith('packet/') and v['type']=='file':write(runtime/n,(P/n.split('/',1)[1]).read_bytes(),0o444)
    
    for n,v in tree.items():
        if v['type']=='dir':(runtime/n).chmod(v['mode'])
    runtime.chmod(0o755);readback=t.verify(runtime,tree)
    doc(B/'runtime-readback.json',readback)
    tools={}
    for role,rel in {'losetup':'usr/sbin/losetup','mkfs.ext4':'usr/sbin/mke2fs','mount':'usr/bin/mount'}.items():
        resolved=t.resolve(tree,rel);tools[role]={'relativePath':rel,'sha256':tree[resolved]['sha256']}
    admission={**context,'decision':'preparation-only-exact-source-admitted','mode':'preparation-only','runtimeRoot':str(runtime),'runtimeTreeSha256':readback['treeSha256'],'planPath':str(P/'RUNTIME-ROOT-PLAN.json'),'canonicalPlanSha256':t.digest(plan),'tools':tools,'backingPolicy':'same-backing-fixed-v1','inputs':{n:{'source':str(paths[v['sha256']]),'sha256':v['sha256']} for n,v in closure['inputs'].items()}}
    worker=t.resolve(tree,'python/bin/python3')
    admission['runtimeIdentities']={'workerExecutable':worker,'workerExecutableSha256':tree[worker]['sha256'],'daemonHashes':{n:tree['docker/'+n]['sha256'] for n in ['dockerd','containerd','containerd-shim-runc-v2']},'observerSha256':manifest['files']['outside-observer.py'],'collectorSha256':manifest['files']['external-collector.py']}
    doc(B/'admission.json',admission)
    # Pinned runtime interpreter begins only after full graph/readback. No compiler/daemon.
    loader=runtime/'usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2';py=runtime/t.resolve(tree,'python/bin/python3')
    lib=':'.join(str(runtime/n) for n in ['usr/lib/x86_64-linux-gnu','usr/lib/x86_64-linux-gnu/systemd','python/lib'])
    result=subprocess.run([str(loader),'--library-path',lib,str(py),'-I',str(P/'preparation-only.py')],env={'PATH':str(runtime/'python/bin'),'LANG':'C','HOME':'/nonexistent','TMPDIR':str(B/'scratch')},stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=300)
    doc(B/'terminal.json',{'exit':result.returncode,**context});need(result.returncode==0)
if __name__=='__main__':main()
