"""Future admitted private-daemon compiler-fit supervisor. No export admission.
All binary paths fixed inside isolated runtime root. Candidate runs without socket.
"""
import os,pathlib,json,time,subprocess,signal,importlib.util,hashlib

def module(name):
    s=importlib.util.spec_from_file_location(name,'/packet/'+name+'.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
c=module('control-common');immutable=module('immutable-input')
DOCKER=['/docker/docker','--host=unix:///state/docker.sock','--config=/state/client']

def docker(*args,**kwargs):return c.command(DOCKER+list(args),**kwargs)

def group(name,limit):
    p=pathlib.Path('/sys/fs/cgroup')/name;p.mkdir()
    for f,v in [('memory.max',str(limit)),('memory.swap.max','0'),('pids.max','96'),('memory.oom.group','1')]:
        (p/f).write_text(v);c.require((p/f).read_text().strip()==v)
    return p

def move(p):
    def child():(p/'cgroup.procs').write_text(str(os.getpid()))
    return child

def main(path):
    fd=c.protected(path);a=c.json_fd(fd);os.close(fd)
    c.require(a['mode']=='compiler-fit' and a['decision']=='compiler-fit-only')
    module('clean-bindings').validate(a)
    for name,digest in a['modules'].items():
        c.require('/' not in name);fd=c.protected('/packet/'+name)
        with os.fdopen(fd,'rb') as src:c.require(hashlib.file_digest(src,'sha256').hexdigest()==digest)
    c.require(set(os.environ)<= {'PATH','LANG','HOME','TMPDIR','INVOCATION_ID','JOURNAL_STREAM','SYSTEMD_EXEC_PID'})
    c.require(pathlib.Path('/sys/fs/cgroup/memory.max').read_text().strip()=='1610612736')
    c.require(pathlib.Path('/proc/net/route').read_text().count('\n')==1)
    c.require(not pathlib.Path('/var/run/docker.sock').exists() and not pathlib.Path('/root/.docker').exists())
    os.chown('/state/work',1000,1000)
    for d in ['client','daemon-control']:pathlib.Path('/state',d).mkdir(mode=0o700)
    daemon_group=group('private-daemon',384*1024**2);group('compile',768*1024**2)
    daemon=subprocess.Popen(['/docker/dockerd','--host=unix:///state/docker.sock','--data-root=/state/docker','--exec-root=/state/exec','--pidfile=/state/dockerd.pid','--bridge=none','--iptables=false','--ip6tables=false','--ip-forward=false','--ip-masq=false','--storage-driver=vfs','--exec-opt=native.cgroupdriver=cgroupfs','--log-driver=none'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={'PATH':'/docker','HOME':'/nonexistent','TMPDIR':'/state/tmp'},close_fds=True,start_new_session=True,preexec_fn=move(daemon_group))
    container=None;deadline=time.monotonic()+60
    try:
        while not pathlib.Path('/state/docker.sock').exists():
            c.require(daemon.poll() is None and time.monotonic()<deadline);time.sleep(.1)
        info=json.loads(docker('info','--format','{{json .}}'))
        c.require(info['DockerRootDir']=='/state/docker' and info['CgroupVersion']=='2' and info['CgroupDriver']=='cgroupfs')
        runner=a['runner']
        c.require(runner['sourceIndex']=='sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2')
        c.require(a['dependencyFormat']=='clean-npm-layout-v1')
        with immutable.open_verified(runner['path'],runner['sha256'],runner['veritySha256'],2*1024**3) as f:
            node_tar=module('node-import').convert(f,a['nodeReceipt'],'/state/raw/node-import.tar')
        with open(node_tar,'rb') as f:docker('load',stdin=f,timeout=120,cap=65536)
        # No pulls; exact immutable image ID, not tag selection.
        image=json.loads(docker('image','inspect',runner['imageId']))[0];c.require(image['Id']==runner['imageId'])
        container=docker('create','--pull=never','--network=none','--read-only','--user=1000:1000','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=64','--memory=768m','--memory-swap=768m','--cgroup-parent=/compile','--log-driver=none','--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=33554432','--mount=type=bind,source=/state/work,target=/work','--env=NODE_OPTIONS=--max-old-space-size=512','--env=HOME=/tmp','--env=TMPDIR=/work/tmp','--workdir=/work',runner['imageId'],'sleep','600').decode().strip()
        c.require(len(container)==64 and all(x in '0123456789abcdef' for x in container))
        c.record('/state/journal/container.json',{'id':container,'image':runner['imageId']})
        item=a['source']
        with immutable.open_verified(item['path'],item['sha256'],item['veritySha256'],1024**3) as f:
            normalized=module('import-owned').normalize(f,'/state/raw/source.tar')
        with open(normalized,'rb') as f:docker('cp','-',container+':/work',stdin=f,timeout=120,cap=65536)
        module('assemble-npm').assemble(a['npmLayout'],a['npmAdmission'],'/state/raw/clean-dependencies.tar')
        with open('/state/raw/clean-dependencies.tar','rb') as f:docker('cp','-',container+':/work',stdin=f,timeout=120,cap=65536)
        docker('start',container)
        inspect=json.loads(docker('inspect',container))[0];host=inspect['HostConfig']
        c.require(host['NetworkMode']=='none' and host['Privileged']==False and host['ReadonlyRootfs'])
        c.require(host['Memory']==805306368 and host['MemorySwap']==805306368 and host['CapDrop']==['ALL'])
        c.require(inspect['Config']['User']=='1000:1000' and host['CgroupParent']=='/compile')
        c.require(all(x['Destination'] in ['/work'] for x in inspect['Mounts']))
        pid=inspect['State']['Pid'];c.require(pid>0)
        pid_namespace=os.readlink('/proc/self/ns/pid')
        c.require(pid_namespace==os.readlink('/proc/1/ns/pid')==os.readlink('/proc/'+str(daemon.pid)+'/ns/pid'))
        for proc_id in [os.getpid(),daemon.pid]:
            line=next(x for x in pathlib.Path('/proc',str(proc_id),'status').read_text().splitlines() if x.startswith('NSpid:'))
            c.require([int(x) for x in line.split()[1:]]==[proc_id])
        request={'runId':a['runId'],'packetSha256':a['packetSha256'],'containerId':container,'pidNamespace':pid_namespace,'roles':{'worker':os.getpid(),'daemon':daemon.pid,'container':pid}}
        c.record('/state/journal/observe-request.json',request)
        gate=pathlib.Path('/state/observer-gate/ready.json')
        ready=c.wait_ack(gate,lambda:daemon.poll() is None)
        for k in ['runId','packetSha256','containerId']:c.require(ready[k]==request[k])
        c.require(ready['requestSha256']==hashlib.sha256(json.dumps(request,sort_keys=True).encode()).hexdigest())
        completions=[]
        # Each build is a separately bounded fixed argv; no npm lifecycle shell.
        for target in ['packages/codeops-contracts','services/codeops-control-gateway']:
            docker('exec','--workdir=/work/'+target,container,'/usr/local/bin/node','/work/node_modules/typescript/bin/tsc','-p','tsconfig.build.json',timeout=240,cap=8*1024**2)
            completions.append({'target':target,'exitCode':0})
        transition={**{k:request[k] for k in ['runId','packetSha256','containerId']},'phase':'compilers-complete','compilers':completions,'exportPerformed':False}
        c.record('/state/journal/teardown-request.json',transition)
        ack=pathlib.Path('/state/observer-gate/teardown.json')
        accepted=c.wait_ack(ack,lambda:daemon.poll() is None)
        for k in ['runId','packetSha256','containerId']:c.require(accepted[k]==request[k])
        c.require(accepted['transitionSha256']==hashlib.sha256(json.dumps(transition,sort_keys=True).encode()).hexdigest())
        docker('stop','--time=2',container)
        c.require(not json.loads(docker('inspect',container))[0]['State']['Running'])
        c.record('/state/journal/fit.json',{'runId':a['runId'],'packetSha256':a['packetSha256'],'containerId':container,'containerStopped':True,'compilers':completions,'result':'compiler-exit-zero','memoryPeak':pathlib.Path('/sys/fs/cgroup/compile/memory.peak').read_text(),'events':pathlib.Path('/sys/fs/cgroup/compile/memory.events').read_text(),'exportPerformed':False})
    finally:
        # Scoped kill, preserve Docker data and object IDs; no broad prune/retry.
        if container:
            try:docker('stop','--time=1',container,timeout=10)
            except Exception:pass
        if daemon.poll() is None:os.killpg(daemon.pid,signal.SIGTERM)
        try:daemon.wait(timeout=10)
        except subprocess.TimeoutExpired:os.killpg(daemon.pid,signal.SIGKILL);daemon.wait()

if __name__=='__main__':
    import sys
    c.require(len(sys.argv)==2);main(sys.argv[1])
