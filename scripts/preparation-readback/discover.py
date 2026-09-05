#!/usr/bin/python3
"""Discovery only: no admission, subprocess, network, mount, or workload operations."""
import hashlib,json,os,pathlib,resource,signal,stat,sys

def read(path,cap=1048576):
    with open(path,'rb') as f:b=f.read(cap+1)
    if len(b)>cap:raise ValueError('metadata bound')
    return b

def tool(path):
    resolved=os.path.realpath(path)
    fd=os.open(resolved,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_size>268435456:raise ValueError('tool bound')
        h=hashlib.sha256()
        while True:
            b=os.read(fd,1048576)
            if not b:break
            h.update(b)
        t=os.fstat(fd)
        if (s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)!=(t.st_ino,t.st_size,t.st_mtime_ns,t.st_ctime_ns):raise ValueError('tool changed')
        return dict(path=path,resolved=resolved,sha256=h.hexdigest(),bytes=s.st_size,device=s.st_dev,inode=s.st_ino,uid=s.st_uid,mode=stat.S_IMODE(s.st_mode))
    finally:os.close(fd)

def main():
    signal.alarm(20)
    if os.geteuid()==0:raise ValueError('non-root required')
    # Only the workflow's non-secret provenance allowlist enters this process.
    keys=['RB_REPOSITORY','RB_SHA','RB_WORKFLOW_SHA','RB_WORKFLOW_REF','RB_RUN_ID','RB_ATTEMPT','RB_JOB','RB_IMAGE_OS','RB_IMAGE_VERSION']
    context={k:os.environ.get(k,'') for k in keys}
    if context['RB_REPOSITORY']!='anulman/codeops' or any(not context[k] for k in keys[:7]):raise ValueError('context')
    if any(len(v)>512 for v in context.values()):raise ValueError('context bound')
    meta={}
    for path in ['/proc/sys/kernel/random/boot_id','/proc/self/cgroup','/proc/1/cgroup','/sys/fs/cgroup/cgroup.controllers','/sys/fs/cgroup/cgroup.type']:
        try:meta[path]=read(path,8192).decode().strip()
        except OSError as e:meta[path]={'unavailable':type(e).__name__}
    mounts=read('/proc/self/mountinfo')
    # Bounded mount topology, not environment or arbitrary process command lines.
    selected=[]
    for line in mounts.decode().splitlines():
        f=line.split();sep=f.index('-')
        if f[4] in ['/', '/mnt','/tmp','/sys/fs/cgroup','/proc']:
            selected.append({'id':f[0],'parent':f[1],'device':f[2],'root':f[3],'target':f[4],'options':f[5],'fstype':f[sep+1]})
    fs=[]
    for path in ['/','/mnt','/tmp']:
        s=os.statvfs(path);t=os.stat(path)
        fs.append(dict(path=path,device=t.st_dev,availableBytes=s.f_bavail*s.f_frsize,freeInodes=s.f_favail,totalBytes=s.f_blocks*s.f_frsize))
    mem={}
    for line in read('/proc/meminfo',65536).decode().splitlines():
        a=line.split()
        if a[0] in ['MemTotal:','MemAvailable:','SwapTotal:','SwapFree:']:mem[a[0][:-1]]=int(a[1])*1024
    namespaces={}
    for path in ['/proc/self/ns/pid','/proc/1/ns/pid','/proc/self/ns/mnt','/proc/self/ns/net']:
        try:namespaces[path]=os.readlink(path)
        except OSError as e:namespaces[path]={'unavailable':type(e).__name__}
    result=dict(schema='codeops-discovery-v1',executionAdmitted=False,context=context,bootAndCgroup=meta,namespaces=namespaces,kernel=list(os.uname()),mountinfoSha256=hashlib.sha256(mounts).hexdigest(),mounts=selected,filesystems=fs,memoryBytes=mem,tools=[tool(x) for x in ['/usr/bin/python3','/usr/bin/bash','/usr/bin/timeout','/usr/bin/sha256sum']],scriptSha256=hashlib.sha256(read(__file__,65536)).hexdigest(),createdWorkloadObjects=[],limits={str(k):resource.getrlimit(k) for k in [resource.RLIMIT_AS,resource.RLIMIT_CPU,resource.RLIMIT_FSIZE,resource.RLIMIT_NOFILE]})
    b=json.dumps(result,sort_keys=True).encode()+b'\n'
    if len(b)>32768:raise ValueError('receipt bound')
    os.write(1,b)
if __name__=='__main__':
    try:main()
    except Exception as e:
        os.write(2,(json.dumps({'executionAdmitted':False,'errorType':type(e).__name__})+'\n').encode());sys.exit(1)
