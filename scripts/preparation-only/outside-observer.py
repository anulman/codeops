"""Future host observer; no Docker claims or in-container cgroup substrings trusted."""
import os,pathlib,json,hashlib,importlib.util,time
s=importlib.util.spec_from_file_location('c',pathlib.Path(__file__).with_name('control-common.py'));c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
PROC=pathlib.Path('/proc')
CGROOT=pathlib.Path('/sys/fs/cgroup')
def proc(pid):
    p=PROC/str(pid);stat=(p/'stat').read_text();tail=stat[stat.rfind(')')+2:].split()
    groups=(p/'cgroup').read_text().splitlines();c.require(len(groups)==1 and groups[0].startswith('0::/'))
    cg=CGROOT/groups[0][4:];c.require('..' not in cg.parts)
    status={l.split(':')[0]:l.split(':',1)[1].strip() for l in (p/'status').read_text().splitlines() if ':' in l}
    return {'pid':pid,'start':int(tail[19]),'parent':int(tail[1]),'group':str(cg),'groupInode':cg.stat().st_ino,'exe':os.readlink(p/'exe'),'nspid':[int(x) for x in status['NSpid'].split()],'pidNamespace':os.readlink(p/'ns/pid'),'net':os.readlink(p/'ns/net'),'mnt':os.readlink(p/'ns/mnt'),'rootIdentity':[os.stat(p/'root').st_dev,os.stat(p/'root').st_ino]}
def mapped_executable(p,contract,relative,expected):
    # The general opener never traverses procfs magic links. Open the admitted
    # protected runtime file, then use only procfs stat for an identity comparison.
    c.require(not pathlib.Path(relative).is_absolute() and '..' not in pathlib.Path(relative).parts)
    target=pathlib.Path(contract['runtimeRoot'])/relative
    fd=c.protected(target)
    try:
        before=proc(p['pid']);c.require(before==p)
        a=os.fstat(fd);b=os.stat(PROC/str(p['pid'])/'exe')
        c.require((a.st_dev,a.st_ino)==(b.st_dev,b.st_ino))
        with os.fdopen(os.dup(fd),'rb') as stream:
            c.require(hashlib.file_digest(stream,'sha256').hexdigest()==expected)
        c.require(os.path.samefile(PROC/str(p['pid'])/'root',contract['runtimeRoot']))
        c.require(proc(p['pid'])==before)
    finally:os.close(fd)

def executable(p,contract,name):
    mapped_executable(p,contract,'docker/'+name,contract['daemonHashes'][name])

def inventory():
    out={}
    for p in PROC.iterdir():
        if p.name.isdigit():
            try:out[int(p.name)]=proc(int(p.name))
            except (FileNotFoundError,ProcessLookupError):continue
    return out

def subtree(group,p):
    path=pathlib.Path(p['group']);c.require(path==group or group in path.parents)
    # Re-open every ancestor, compare admitted root inode outside worker namespace.
    while True:
        st=path.stat();c.require(st.st_dev==group.stat().st_dev)
        if path==group:break
        path=path.parent
    return True

def bounded_text(path,cap=1024*1024):
    with open(path,'rb') as f:b=f.read(cap+1)
    c.require(len(b)<=cap);return b.decode()

def shared_pid_namespace():
    # Support only the observer's proven initial/procfs PID coordinate system.
    # A nested observer or differently mounted procfs is refused, not guessed.
    ns=os.readlink(PROC/'self/ns/pid')
    c.require(ns==os.readlink(PROC/'1/ns/pid'))
    status=bounded_text(PROC/'self/status')
    ids=[int(x) for x in next(l for l in status.splitlines() if l.startswith('NSpid:')).split()[1:]]
    c.require(ids==[os.getpid()])
    return ns

def observe(group,worker_pid,known,contract,request=None,phase="running"):
    c.require(phase in ("running","teardown"))
    group=pathlib.Path(group);st=group.stat();c.require([st.st_dev,st.st_ino]==contract['groupIdentity'])
    c.require(set((group/'cgroup.controllers').read_text().split())>= {'memory','pids'})
    c.require(set((group/'cgroup.subtree_control').read_text().split())>= {'memory','pids'})
    for k,v in {'memory.max':'1610612736','memory.swap.max':'0','memory.oom.group':'1','pids.max':'256'}.items():c.require((group/k).read_text().strip()==v)
    namespace=shared_pid_namespace()
    if 'observerPidNamespace' in contract:c.require(contract['observerPidNamespace']==namespace)
    else:contract['observerPidNamespace']=namespace
    ps=inventory();c.require(worker_pid in ps);worker=ps[worker_pid];subtree(group,worker)
    c.require(worker['pidNamespace']==namespace and worker['nspid']==[worker_pid])
    if contract.get('workerStart') is not None:c.require(worker['start']==contract['workerStart'])
    else:contract['workerStart']=worker['start']
    descendants={worker_pid}
    for pid,start in known.items():
        if pid in ps:
            c.require(ps[pid]['start']==start);descendants.add(pid)
    for _ in range(256):
        more={pid for pid,p in ps.items() if p['parent'] in descendants}
        if more<=descendants:break
        descendants|=more
    else:c.require(False)
    # Include cgroup inhabitants even if ancestry was reparented before a sample.
    for pid,p in ps.items():
        path=pathlib.Path(p['group'])
        if path==group or group in path.parents:descendants.add(pid)
    c.require(len(descendants)<=256)
    for pid in descendants:
        p=ps[pid];subtree(group,p);known[pid]=p['start']
    c.require(worker['net']!=os.readlink(PROC/'self/ns/net'))
    c.require(worker['mnt']!=os.readlink(PROC/'self/ns/mnt'))
    mapped_executable(worker,contract,contract['workerExecutable'],contract['workerExecutableSha256'])
    root=PROC/str(worker_pid)/'root'
    c.require(os.path.samefile(root,contract['runtimeRoot']))
    c.require(os.path.samefile(root/'state',contract['state']))
    c.require(os.path.samefile(root/'inputs',pathlib.Path(contract['state'])/'sealed'))
    c.require(os.path.samefile(root/'sys/fs/cgroup',group))
    c.require(not (root/'var/run/docker.sock').exists() and not (root/'root/.docker').exists())
    c.require(bounded_text(PROC/str(worker_pid)/'net/route').count('\n')==1)
    # Exact independently admitted mountpoint/type/readonly policy; no omitted extras.
    mounts=[]
    for line in bounded_text(PROC/str(worker_pid)/'mountinfo').splitlines():
        a,b=line.split(' - ');f=a.split();g=b.split();mounts.append({'target':f[4],'type':g[0],'readonly':'ro' in f[5].split(',')})
    c.require(sorted(mounts,key=lambda x:x['target'])==contract['mountPolicy'])
    # All live descendants need a production-route-free network namespace.
    for pid in descendants:
        c.require(ps[pid]['net']!=os.readlink(PROC/'self/ns/net'))
        c.require(bounded_text(PROC/str(pid)/'net/route').count('\n')==1)
    observed={'worker':worker,'processes':[ps[x] for x in sorted(descendants)],'mounts':mounts}
    if request:
        for child,limit in [('private-daemon',402653184),('compile',805306368)]:
            cg=group/child
            c.require((cg/'memory.max').read_text().strip()==str(limit) and (cg/'memory.swap.max').read_text().strip()=='0')
        c.require(request['pidNamespace']==namespace)
        roles={}
        for role,ns_pid in request['roles'].items():
            c.require(type(ns_pid) is int and ns_pid>0)
            # Docker State.Pid is in the daemon namespace, proved shared above.
            matches=[ps[x] for x in descendants if x==ns_pid]
            for found in matches:c.require(found['nspid'] and found['nspid'][0]==found['pid'])
            c.require(len(matches)<=1)
            if phase=='running':c.require(len(matches)==1)
            if matches:roles[role]=matches[0]
        c.require(set(request['roles'])=={'worker','daemon','container'} and len(set(request['roles'].values()))==3)
        if phase=='running':c.require(set(roles)=={'worker','daemon','container'})
        c.require(roles['worker']['pid']==worker_pid)
        if 'daemon' in roles:
            c.require(roles['daemon']['pidNamespace']==namespace and roles['daemon']['nspid']==[roles['daemon']['pid']])
            c.require(pathlib.Path(roles['daemon']['group'])==group/'private-daemon')
            c.require(pathlib.Path(roles['daemon']['exe']).name=='dockerd')
        if 'container' in roles:c.require(pathlib.Path(roles['container']['group']).is_relative_to(group/'compile'))
        names=[pathlib.Path(ps[x]['exe']).name for x in descendants]
        if phase=='running':c.require('containerd' in names and any(n.startswith('containerd-shim') for n in names))
        for pid in descendants:
            p=ps[pid];name=pathlib.Path(p['exe']).name
            if name=='dockerd' or name=='containerd' or name.startswith('containerd-shim'):
                c.require(pathlib.Path(p['group']).is_relative_to(group/'private-daemon'))
                cmd=bounded_text(PROC/str(pid)/'cmdline',65536).split('\0')
                if name=='dockerd':
                    for arg in ['--host=unix:///state/docker.sock','--data-root=/state/docker','--exec-root=/state/exec']:c.require(arg in cmd)
                executable(p,contract,name)
        if 'container' in roles:
            container=roles['container'];cp=PROC/str(container['pid'])
            c.require(container['net']!=worker['net'] and bounded_text(cp/'net/route').count('\n')==1)
            cm=bounded_text(cp/'mountinfo')
            for line in cm.splitlines():
                left,right=line.split(' - ');fields=left.split()
                if fields[4]=='/sys/fs/cgroup':c.require('ro' in fields[5].split(','))
            c.require(' /var/run/docker.sock ' not in cm and ' /inputs ' not in cm and ' /state ' not in cm)
            status=bounded_text(cp/'status');c.require('CapEff:\t0000000000000000' in status and 'NoNewPrivs:\t1' in status)
            c.require(not (cp/'root/var/run/docker.sock').exists())
        observed['roles']=roles
    c.require(proc(worker_pid)==worker)
    return observed
