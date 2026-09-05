"""Reviewed future preparation ONLY. No worker/daemon/compiler/harness import or launch."""
import os,pathlib,json,hashlib,importlib.util,uuid,fcntl
BASE=pathlib.Path(__file__).parent

def module(name):
    spec=importlib.util.spec_from_file_location(name,BASE/(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
c=module('control-common')

def read(path,cap=65536):
    with open(path,'rb') as f:
        b=f.read(cap+1);c.require(len(b)<=cap);return b.decode()

def document(path,cap=8*1024*1024):
    fd=c.protected(path)
    try:return c.json_fd(fd,cap)
    finally:os.close(fd)

def capacity(root):
    v=os.statvfs(root);m={x.split(':')[0]:int(x.split()[1])*1024 for x in read('/proc/meminfo').splitlines() if ':' in x and len(x.split())>=2}
    return {'freeBytes':v.f_bavail*v.f_frsize,'freeInodes':v.f_favail,'availableRam':m['MemAvailable'],'totalRam':m['MemTotal']}

def run(path):
    c.require(os.geteuid()==0)
    a=document(path);c.require(a['decision']=='preparation-only-exact-source-admitted')
    c.require(a['mode']=='preparation-only' and a['executionAdmitted'] is False)
    packet=document(BASE/'PACKET.json')
    c.require(hashlib.sha256((BASE/'PACKET.json').read_bytes()).hexdigest()==a['packetSha256'])
    for n,h in packet['files'].items():
        fd=c.protected(BASE/n)
        with os.fdopen(fd,'rb') as f:c.require(hashlib.file_digest(f,'sha256').hexdigest()==h)
    t=module('runtime-topology')
    plan=document(a['planPath']);c.require(t.digest(plan)==a['canonicalPlanSha256'])
    runtime=pathlib.Path(a['runtimeRoot']);tree=t.expected(plan,packet);runtime_readback=t.verify(runtime,tree)
    c.require(runtime_readback['treeSha256']==a['runtimeTreeSha256'])
    # Protected placement verified all runtime bytes before this interpreter/import.
    allowed={str(runtime/n):v['sha256'] for n,v in tree.items() if v['type']=='file'}
    for line in read('/proc/self/maps',262144).splitlines():
        fields=line.split()
        if len(fields)>=6 and fields[-1].startswith('/') and 'x' in fields[1]:
            c.require(fields[-1] in allowed)
            fd=c.protected(fields[-1])
            with os.fdopen(fd,'rb') as f:c.require(hashlib.file_digest(f,'sha256').hexdigest()==allowed[fields[-1]])
    # Admission is host/run-specific; stale metadata from a completed VM cannot admit it.
    boot=read('/proc/sys/kernel/random/boot_id').strip();c.require(boot==a['bootId'])
    ids={str(pid):os.readlink('/proc/'+str(pid)+'/ns/pid') for pid in (1,os.getpid())}
    c.require(len(set(ids.values()))==1 and ids['1']==a['pidNamespace'])
    c.require([int(x) for x in read('/proc/self/status').split('NSpid:')[1].splitlines()[0].split()]==[os.getpid()])
    mounts=read('/proc/self/mountinfo',262144);c.require(any(' /proc ' in x and ' - proc ' in x for x in mounts.splitlines()))
    c.require(any(' /sys/fs/cgroup ' in x and ' - cgroup2 ' in x for x in mounts.splitlines()))
    cg=pathlib.Path('/sys/fs/cgroup');controllers=read(cg/'cgroup.controllers').split();c.require({'memory','pids'}<=set(controllers))
    group=read('/proc/self/cgroup');c.require(group==a['preparationCgroup'])
    root=pathlib.Path(a['runRoot']);fd=c.protected(root,True);os.close(fd)
    c.require(root.name==str(uuid.UUID(a['runId'])) and not list(root.iterdir()))
    lock=os.open(root/'lock',os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_NOFOLLOW,0o400)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        before=capacity(root);c.require(before['freeBytes']>=32*1024**3 and before['freeInodes']>=262144 and before['availableRam']>=3*1024**3 and before['totalRam']>=4*1024**3)
        c.record(root/'intent.json',{'runId':a['runId'],'bootId':boot,'packetSha256':a['packetSha256'],'phase':'preparation-only','backingPolicy':a['backingPolicy']})
        tools={}
        loader=str(runtime/'usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2')
        library=':'.join(str(runtime/x) for x in ['usr/lib/x86_64-linux-gnu','usr/lib/x86_64-linux-gnu/systemd','python/lib'])
        c.require(set(a['tools'])=={'losetup','mkfs.ext4','mount'})
        for name,item in a['tools'].items():
            rel=t.resolve(tree,item['relativePath']);c.require(tree[rel]['sha256']==item['sha256'])
            tools[name]=[loader,'--library-path',library,str(runtime/rel)]
        state=module('bounded-disk').prepare(root,tools,a['backingPolicy'])
        sealed=state/'sealed';sealed.mkdir(mode=0o700);proofs={}
        c.require(set(a['inputs'])=={'source','runner'}|{'npm-'+str(i).zfill(2) for i in range(44)})
        for name,item in a['inputs'].items():
            proofs[name]=module('stage-sealed-input').stage(item['source'],str(sealed/(name+'.tar')),item['sha256'])
        binding=module('clean-bindings').bind(document(BASE/'ADMISSION-TEMPLATE.json'),proofs,a,{n:h for n,h in packet['files'].items() if n.endswith('.py')})
        c.record(root/'clean-input-bindings.json',binding)
        after=capacity(root);c.require(after['freeBytes']>=16*1024**3 and after['freeInodes']>=262144)
        c.record(root/'preparation-receipt.json',{'runId':a['runId'],'bootId':boot,'packetSha256':a['packetSha256'],'runtime':runtime_readback,'pidNamespaces':ids,'procMounts':mounts,'preparationCgroup':group,'controllers':controllers,'cgroupDeviceInode':[cg.stat().st_dev,cg.stat().st_ino],'sealedInputs':proofs,'beforeAllocation':before,'afterAllocation':after,'stateDevice':state.stat().st_dev,'backingDevice':root.stat().st_dev,'leftovers':sorted(p.name for p in root.iterdir()),'decision':'NOT_ADMITTED','executionAdmitted':False,'daemonStarted':False,'compilerStarted':False,'harnessStarted':False})
    finally:os.close(lock)

if __name__=='__main__':
    # No caller-controlled command or arbitrary phase selection.
    run('/opt/codeops-preparation/admission.json')
